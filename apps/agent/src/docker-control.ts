import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import Dockerode from 'dockerode';
import type { Container, ContainerCreateOptions, ContainerInspectInfo } from 'dockerode';
import { z } from 'zod';
import type { ManagerCommand } from '@craftdock/protocol';

const MANAGED_LABEL = 'craftdock.managed';
const SERVER_ID_LABEL = 'craftdock.serverId';
const JAVA_MAJORS = new Set([8, 17, 21, 25]);
const ALPINE_IMAGE = 'alpine:3.22';
const MAX_SERVER_JAR_BYTES = 256 * 1024 * 1024;
const MINECRAFT_VERSION_RE = /^\d+\.\d+(?:\.\d+)?$/;

const VersionManifestSchema = z.object({
  versions: z
    .array(
      z.object({ id: z.string().max(32), url: z.string().url(), type: z.string() }).passthrough(),
    )
    .max(10_000),
});
const VersionMetadataSchema = z
  .object({
    downloads: z.object({
      server: z
        .object({
          url: z.string().url(),
          sha1: z.string().regex(/^[a-f0-9]{40}$/i),
          size: z.number().int().positive(),
        })
        .passthrough(),
    }),
    javaVersion: z.object({ majorVersion: z.number().int().positive() }).passthrough(),
  })
  .passthrough();

export interface ObservedDockerServer {
  serverId: string;
  state: 'STOPPED' | 'RUNNING' | 'UNKNOWN';
  hostPort: number;
}

export interface DockerSnapshot {
  engineAvailable: boolean;
  servers: ObservedDockerServer[];
}

export interface AgentLogLine {
  serverId: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface DockerCommandResult {
  status: 'SUCCEEDED' | 'FAILED';
  observedState: 'STOPPED' | 'RUNNING' | 'UNKNOWN';
  errorCode?:
    | 'VALIDATION_FAILED'
    | 'DOCKER_UNAVAILABLE'
    | 'IMAGE_PULL_FAILED'
    | 'PORT_IN_USE'
    | 'OPERATION_FAILED'
    | 'SERVER_NOT_RUNNING'
    | 'CONSOLE_UNAVAILABLE'
    | 'COMMAND_RESULT_UNKNOWN';
}

export class DockerControl {
  private readonly docker: Dockerode;
  private readonly logStreams = new Map<
    string,
    { source: NodeJS.ReadableStream; close: () => void }
  >();

  constructor(socketPath = '/var/run/docker.sock') {
    this.docker = new Dockerode({ socketPath, timeout: 30_000 });
  }

  async snapshot(): Promise<DockerSnapshot> {
    try {
      await this.docker.ping();
      const containers = await this.listCraftDockContainers();
      const servers: ObservedDockerServer[] = [];
      const seen = new Set<string>();
      for (const container of containers) {
        const serverId = container.Labels[SERVER_ID_LABEL];
        if (!serverId) {
          continue;
        }
        if (seen.has(serverId)) {
          throw new Error('DUPLICATE_SERVER_CONTAINER');
        }
        seen.add(serverId);
        const inspection = await this.docker.getContainer(container.Id).inspect();
        assertManagedContainer(inspection, serverId);
        const publishedPort = inspection.HostConfig.PortBindings['25565/tcp']?.[0]?.HostPort;
        if (!publishedPort) {
          continue;
        }
        servers.push({
          serverId,
          state: container.State === 'running' ? 'RUNNING' : 'STOPPED',
          hostPort: Number(publishedPort),
        });
      }
      return { engineAvailable: true, servers };
    } catch {
      return { engineAvailable: false, servers: [] };
    }
  }

  async execute(
    command: ManagerCommand,
    emitLog: (event: AgentLogLine) => void,
  ): Promise<DockerCommandResult> {
    if (new Date(command.deadline).getTime() <= Date.now()) {
      return { status: 'FAILED', observedState: 'UNKNOWN', errorCode: 'VALIDATION_FAILED' };
    }

    try {
      if (command.action === 'server.create') {
        const container = await this.ensureContainer(command.serverId, command.server);
        if (command.server.desiredState === 'RUNNING') {
          await this.startContainer(container, command.serverId);
          await this.startLogStream(command.serverId, emitLog);
          return { status: 'SUCCEEDED', observedState: 'RUNNING' };
        }
        return { status: 'SUCCEEDED', observedState: 'STOPPED' };
      }

      if (command.action === 'server.start') {
        const container = await this.ensureContainer(command.serverId, command.server);
        await this.startContainer(container, command.serverId);
        await this.startLogStream(command.serverId, emitLog);
        return { status: 'SUCCEEDED', observedState: 'RUNNING' };
      }

      if (command.action === 'server.console') {
        return await this.sendConsoleCommand(command.serverId, command.command);
      }

      if (command.action === 'server.delete') {
        return await this.deleteServer(command.serverId, command.deleteWorld);
      }

      this.stopLogStream(command.serverId);
      const container = await this.findServerContainer(command.serverId);
      if (!container) {
        return { status: 'SUCCEEDED', observedState: 'STOPPED' };
      }
      const inspection = await container.inspect();
      assertManagedContainer(inspection, command.serverId);
      if (inspection.State.Running) {
        await container.stop({ t: 30 });
      }
      return { status: 'SUCCEEDED', observedState: 'STOPPED' };
    } catch (error) {
      const errorCode =
        command.action === 'server.console' &&
        error instanceof Error &&
        error.message === 'CONSOLE_WRITE_TIMEOUT'
          ? 'COMMAND_RESULT_UNKNOWN'
          : (classifyDockerError(error) ?? 'OPERATION_FAILED');
      return { status: 'FAILED', observedState: 'UNKNOWN', errorCode };
    }
  }

  private async sendConsoleCommand(
    serverId: string,
    command: string,
  ): Promise<DockerCommandResult> {
    const container = await this.findServerContainer(serverId);
    if (!container) {
      return { status: 'FAILED', observedState: 'STOPPED', errorCode: 'SERVER_NOT_RUNNING' };
    }
    const inspection = await container.inspect();
    assertManagedContainer(inspection, serverId);
    if (!inspection.State.Running) {
      return { status: 'FAILED', observedState: 'STOPPED', errorCode: 'SERVER_NOT_RUNNING' };
    }
    if (!inspection.Config.OpenStdin || !inspection.Config.AttachStdin) {
      return { status: 'FAILED', observedState: 'RUNNING', errorCode: 'CONSOLE_UNAVAILABLE' };
    }
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
      logs: false,
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        (stream as typeof stream & { destroy?: () => void }).destroy?.();
        reject(new Error('CONSOLE_WRITE_TIMEOUT'));
      }, 10_000);
      stream.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      stream.write(`${command}\n`, (error?: Error | null) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      });
    });
    stream.end();
    return { status: 'SUCCEEDED', observedState: 'RUNNING' };
  }

  private async deleteServer(serverId: string, deleteWorld: boolean): Promise<DockerCommandResult> {
    this.stopLogStream(serverId);
    const container = await this.findServerContainer(serverId);
    if (container) {
      const inspection = await container.inspect();
      assertManagedContainer(inspection, serverId);
      if (inspection.State.Running) await container.stop({ t: 30 });
      await container.remove({ force: true });
    }

    if (deleteWorld) {
      const volumeName = `craftdock-server-${serverId}`;
      try {
        const volume = await this.docker.getVolume(volumeName).inspect();
        if (
          volume.Name !== volumeName ||
          volume.Labels?.[MANAGED_LABEL] !== 'true' ||
          volume.Labels?.[SERVER_ID_LABEL] !== serverId
        ) {
          throw new Error('VOLUME_LABEL_MISMATCH');
        }
        await this.docker.getVolume(volumeName).remove();
      } catch (error) {
        if (error instanceof Error && error.message === 'VOLUME_LABEL_MISMATCH') throw error;
        if (dockerStatus(error) !== 404) throw error;
      }
    }
    return { status: 'SUCCEEDED', observedState: 'STOPPED' };
  }

  async syncLogStreams(
    servers: ObservedDockerServer[],
    emitLog: (event: AgentLogLine) => void,
  ): Promise<void> {
    const running = new Set(
      servers.filter((server) => server.state === 'RUNNING').map((server) => server.serverId),
    );
    for (const serverId of this.logStreams.keys()) {
      if (!running.has(serverId)) {
        this.stopLogStream(serverId);
      }
    }
    for (const serverId of running) {
      if (!this.logStreams.has(serverId)) {
        await this.startLogStream(serverId, emitLog);
      }
    }
  }

  close(): void {
    for (const serverId of this.logStreams.keys()) {
      this.stopLogStream(serverId);
    }
  }

  private async ensureContainer(
    serverId: string,
    server: Extract<ManagerCommand, { action: 'server.create' | 'server.start' }>['server'],
  ): Promise<Container> {
    const existing = await this.findServerContainer(serverId);
    if (existing) {
      const inspection = await existing.inspect();
      assertManagedContainer(inspection, serverId);
      if (inspection.Name !== `/craftdock-${serverId}`) {
        throw new Error('CONTAINER_NAME_MISMATCH');
      }
      const mappedPort = inspection.HostConfig.PortBindings['25565/tcp']?.[0]?.HostPort;
      const hasConsoleInput = inspection.Config.OpenStdin && inspection.Config.AttachStdin;
      if (mappedPort !== String(server.hostPort) || !hasConsoleInput) {
        const volumeName = `craftdock-server-${serverId}`;
        if (
          !inspection.Mounts.some(
            (mount) =>
              mount.Type === 'volume' && mount.Name === volumeName && mount.Destination === '/data',
          )
        ) {
          throw new Error('WORLD_VOLUME_MISMATCH');
        }
        await this.ensureVolume(volumeName, serverId);
        if (inspection.State.Running) {
          await existing.stop({ t: 30 });
        }
        // The approved port-recovery path removes only this validated container; the named world volume is retained.
        await existing.remove({ force: true });
      } else {
        return existing;
      }
    }

    if (!MINECRAFT_VERSION_RE.test(server.minecraftVersion) || !server.eulaAccepted) {
      throw new Error('INVALID_SERVER_CONFIGURATION');
    }
    const serverJar = await downloadVerifiedServerJar(server.minecraftVersion);
    const javaImage = `eclipse-temurin:${serverJar.javaMajor}-jre-alpine`;
    await this.ensureImage(javaImage);
    await this.ensureImage(ALPINE_IMAGE);

    const volumeName = `craftdock-server-${serverId}`;
    await this.ensureVolume(volumeName, serverId);
    await this.initializeVolume(volumeName, serverId);

    const containerName = `craftdock-${serverId}`;
    const createOptions: ContainerCreateOptions = {
      name: containerName,
      Image: javaImage,
      User: '10001:10001',
      WorkingDir: '/data',
      Entrypoint: ['java'],
      Cmd: [`-Xmx${Math.floor(server.memoryMb * 0.8)}M`, '-jar', '/data/server.jar', 'nogui'],
      Tty: false,
      OpenStdin: true,
      StdinOnce: false,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
      Labels: { [MANAGED_LABEL]: 'true', [SERVER_ID_LABEL]: serverId },
      ExposedPorts: { '25565/tcp': {} },
      HostConfig: {
        AutoRemove: false,
        Privileged: false,
        ReadonlyRootfs: true,
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL'],
        Memory: server.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(server.cpuLimit * 1_000_000_000),
        PidsLimit: 512,
        Init: true,
        RestartPolicy: { Name: 'unless-stopped' },
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
        Mounts: [{ Type: 'volume', Source: volumeName, Target: '/data' }],
        PortBindings: { '25565/tcp': [{ HostIp: '0.0.0.0', HostPort: String(server.hostPort) }] },
      },
    };

    const container = await this.docker.createContainer(createOptions);
    try {
      const archive = createTarArchive([
        { name: 'server.jar', mode: 0o644, content: serverJar.bytes },
        { name: 'eula.txt', mode: 0o644, content: Buffer.from('eula=true\n', 'utf8') },
      ]);
      await container.putArchive(archive, { path: '/data' });
    } catch (error) {
      await container.remove({ force: true }).catch(() => undefined);
      throw error;
    }
    return container;
  }

  private async startContainer(container: Container, serverId: string): Promise<void> {
    const inspection = await container.inspect();
    assertManagedContainer(inspection, serverId);
    if (!inspection.State.Running) {
      await container.start();
    }
  }

  private async findServerContainer(serverId: string): Promise<Container | null> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${SERVER_ID_LABEL}=${serverId}`, `${MANAGED_LABEL}=true`] },
    });
    if (containers.length > 1) {
      throw new Error('DUPLICATE_SERVER_CONTAINER');
    }
    const info = containers[0];
    return info ? this.docker.getContainer(info.Id) : null;
  }

  private async listCraftDockContainers(): Promise<Dockerode.ContainerInfo[]> {
    return this.docker.listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=true`] } });
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      const stream = await this.docker.pull(image);
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()));
      });
    }
  }

  private async ensureVolume(volumeName: string, serverId: string): Promise<void> {
    try {
      const existing = await this.docker.getVolume(volumeName).inspect();
      if (
        existing.Labels?.[SERVER_ID_LABEL] !== serverId ||
        existing.Labels?.[MANAGED_LABEL] !== 'true'
      ) {
        throw new Error('VOLUME_LABEL_MISMATCH');
      }
      return;
    } catch (error) {
      if (error instanceof Error && error.message === 'VOLUME_LABEL_MISMATCH') {
        throw error;
      }
    }
    await this.docker.createVolume({
      Name: volumeName,
      Labels: { [MANAGED_LABEL]: 'true', [SERVER_ID_LABEL]: serverId },
    });
  }

  private async initializeVolume(volumeName: string, serverId: string): Promise<void> {
    const name = `craftdock-bootstrap-${serverId}-${randomUUID()}`;
    const container = await this.docker.createContainer({
      name,
      Image: ALPINE_IMAGE,
      User: '0:0',
      Entrypoint: ['/bin/chown'],
      Cmd: ['10001:10001', '/data'],
      Labels: { 'craftdock.bootstrap': 'true', [SERVER_ID_LABEL]: serverId },
      NetworkDisabled: true,
      HostConfig: {
        AutoRemove: false,
        Privileged: false,
        ReadonlyRootfs: true,
        NetworkMode: 'none',
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN'],
        PidsLimit: 16,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16m' },
        Mounts: [{ Type: 'volume', Source: volumeName, Target: '/data' }],
      },
    });
    try {
      await container.start();
      const result = await container.wait({ condition: 'not-running' });
      if (result.StatusCode !== 0) {
        throw new Error('VOLUME_INITIALIZATION_FAILED');
      }
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  private async startLogStream(
    serverId: string,
    emitLog: (event: AgentLogLine) => void,
  ): Promise<void> {
    this.stopLogStream(serverId);
    const container = await this.findServerContainer(serverId);
    if (!container) {
      return;
    }
    const inspection = await container.inspect();
    if (!inspection.State.Running) {
      return;
    }
    const source = await container.logs({
      stdout: true,
      stderr: true,
      follow: true,
      tail: 100,
      timestamps: false,
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    consumeLines(stdout, (line) => emitLog({ serverId, stream: 'stdout', line }));
    consumeLines(stderr, (line) => emitLog({ serverId, stream: 'stderr', line }));
    this.docker.modem.demuxStream(source, stdout, stderr);
    const close = (): void => {
      (source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      stdout.destroy();
      stderr.destroy();
      this.logStreams.delete(serverId);
    };
    source.on('end', close);
    source.on('error', close);
    this.logStreams.set(serverId, { source, close });
  }

  private stopLogStream(serverId: string): void {
    this.logStreams.get(serverId)?.close();
  }
}

function assertManagedContainer(inspection: ContainerInspectInfo, serverId: string): void {
  const labels = inspection.Config.Labels ?? {};
  if (labels[MANAGED_LABEL] !== 'true' || labels[SERVER_ID_LABEL] !== serverId) {
    throw new Error('CONTAINER_LABEL_MISMATCH');
  }
  const expectedVolume = `craftdock-server-${serverId}`;
  const hasExpectedVolume =
    inspection.Mounts.length === 1 &&
    inspection.Mounts.some(
      (mount) =>
        mount.Type === 'volume' && mount.Destination === '/data' && mount.Name === expectedVolume,
    );
  const command = inspection.Config.Cmd;
  const entrypoint = inspection.Config.Entrypoint;
  const portBindings = inspection.HostConfig.PortBindings as
    Record<string, Array<{ HostIp: string; HostPort: string }>> | undefined;
  const serverPortBinding = portBindings?.['25565/tcp'];
  const hasSafeRuntime =
    inspection.Config.User === '10001:10001' &&
    /^eclipse-temurin:(8|17|21|25)-jre-alpine$/.test(inspection.Config.Image) &&
    inspection.Config.WorkingDir === '/data' &&
    Array.isArray(entrypoint) &&
    entrypoint.length === 1 &&
    entrypoint[0] === 'java' &&
    Array.isArray(command) &&
    command.length === 4 &&
    /^-Xmx\d+M$/.test(command[0] ?? '') &&
    command[1] === '-jar' &&
    command[2] === '/data/server.jar' &&
    command[3] === 'nogui' &&
    inspection.Name === `/craftdock-${labels[SERVER_ID_LABEL]}` &&
    Object.keys(portBindings ?? {}).length === 1 &&
    serverPortBinding?.length === 1 &&
    serverPortBinding[0]?.HostIp === '0.0.0.0' &&
    /^\d+$/.test(serverPortBinding[0]?.HostPort ?? '') &&
    inspection.HostConfig.Privileged !== true &&
    inspection.HostConfig.NetworkMode !== 'host' &&
    !inspection.HostConfig.PidMode &&
    (!inspection.HostConfig.IpcMode || inspection.HostConfig.IpcMode === 'private') &&
    !inspection.HostConfig.Binds?.length &&
    !inspection.HostConfig.VolumesFrom?.length &&
    !inspection.HostConfig.Devices?.length &&
    !inspection.HostConfig.DeviceRequests?.length &&
    !inspection.HostConfig.CapAdd?.length &&
    inspection.HostConfig.ReadonlyRootfs === true &&
    (inspection.HostConfig.CapDrop ?? []).includes('ALL') &&
    (inspection.HostConfig.SecurityOpt ?? []).includes('no-new-privileges:true');
  if (!hasExpectedVolume || !hasSafeRuntime) {
    throw new Error('CONTAINER_CONFIGURATION_MISMATCH');
  }
}

function classifyDockerError(error: unknown): DockerCommandResult['errorCode'] {
  const message = error instanceof Error ? error.message : '';
  const status = dockerStatus(error);
  if (/port is already allocated|address already in use/i.test(message)) {
    return 'PORT_IN_USE';
  }
  if (/pull|manifest unknown|no matching manifest/i.test(message)) {
    return 'IMAGE_PULL_FAILED';
  }
  if (status === 400 || /invalid|mismatch|duplicate|not allowed/i.test(message)) {
    return 'VALIDATION_FAILED';
  }
  if (/ENOENT|ECONNREFUSED|ECONNRESET|socket/i.test(message)) {
    return 'DOCKER_UNAVAILABLE';
  }
  return 'OPERATION_FAILED';
}

function dockerStatus(error: unknown): number | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode;
  }
  return null;
}

async function downloadVerifiedServerJar(
  version: string,
): Promise<{ bytes: Buffer; javaMajor: number }> {
  const manifestResponse = await fetch(
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    },
  );
  const manifestBody = await readBoundedResponse(manifestResponse, 8 * 1024 * 1024);
  const manifest = VersionManifestSchema.parse(JSON.parse(manifestBody.toString('utf8')));
  const selected = manifest.versions.find(
    (entry) => entry.id === version && entry.type === 'release',
  );
  if (!selected || !isAllowedMojangUrl(selected.url, 'piston-meta.mojang.com')) {
    throw new Error('MINECRAFT_VERSION_UNAVAILABLE');
  }

  const metadataResponse = await fetch(selected.url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const metadataBody = await readBoundedResponse(metadataResponse, 4 * 1024 * 1024);
  const metadata = VersionMetadataSchema.parse(JSON.parse(metadataBody.toString('utf8')));
  if (!isAllowedMojangUrl(metadata.downloads.server.url, 'piston-data.mojang.com')) {
    throw new Error('MINECRAFT_DOWNLOAD_URL_REJECTED');
  }
  if (
    metadata.downloads.server.size > MAX_SERVER_JAR_BYTES ||
    !JAVA_MAJORS.has(metadata.javaVersion.majorVersion)
  ) {
    throw new Error('MINECRAFT_VERSION_UNSUPPORTED');
  }

  const serverResponse = await fetch(metadata.downloads.server.url, {
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  const bytes = await readBoundedResponse(serverResponse, MAX_SERVER_JAR_BYTES);
  if (
    createHash('sha1').update(bytes).digest('hex') !== metadata.downloads.server.sha1.toLowerCase()
  ) {
    throw new Error('MINECRAFT_DOWNLOAD_HASH_MISMATCH');
  }
  return { bytes, javaMajor: metadata.javaVersion.majorVersion };
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.ok || !response.body) {
    throw new Error('REMOTE_DOWNLOAD_FAILED');
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > maximumBytes) {
    throw new Error('REMOTE_DOWNLOAD_TOO_LARGE');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error('REMOTE_DOWNLOAD_TOO_LARGE');
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function isAllowedMojangUrl(value: string, hostname: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function createTarArchive(files: Array<{ name: string; mode: number; content: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, file.name);
    writeTarOctal(header, 100, 8, file.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, file.content.length);
    writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1_000));
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    writeTarString(header, 257, 6, 'ustar');
    writeTarString(header, 263, 2, '00');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, file.content);
    const remainder = file.content.length % 512;
    if (remainder) blocks.push(Buffer.alloc(512 - remainder));
  }
  blocks.push(Buffer.alloc(1_024));
  return Buffer.concat(blocks);
}

function writeTarString(buffer: Buffer, offset: number, maximumBytes: number, value: string): void {
  buffer.write(value.slice(0, maximumBytes), offset, maximumBytes, 'ascii');
}

function writeTarOctal(buffer: Buffer, offset: number, width: number, value: number): void {
  buffer.write(
    `${Math.max(0, value)
      .toString(8)
      .padStart(width - 1, '0')}\0`,
    offset,
    width,
    'ascii',
  );
}

function consumeLines(stream: PassThrough, emit: (line: string) => void): void {
  let buffered = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      emit(buffered.slice(0, newline).replace(/\r$/, '').slice(0, 4_000));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
    if (buffered.length > 4_000) {
      emit(buffered.slice(0, 4_000));
      buffered = buffered.slice(4_000);
    }
  });
  stream.on('end', () => {
    if (buffered) emit(buffered.slice(0, 4_000));
  });
}
