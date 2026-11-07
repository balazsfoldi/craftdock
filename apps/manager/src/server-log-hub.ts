export interface ServerLogEvent {
  serverId: string;
  stream: 'stdout' | 'stderr';
  line: string;
  timestamp: string;
}

export class ServerLogHub {
  private readonly listeners = new Map<string, Set<(event: ServerLogEvent) => void>>();

  publish(event: ServerLogEvent): void {
    const safeEvent = { ...event, line: redactIpAddresses(event.line) };
    for (const listener of this.listeners.get(event.serverId) ?? []) {
      listener(safeEvent);
    }
  }

  subscribe(serverId: string, listener: (event: ServerLogEvent) => void): () => void {
    let serverListeners = this.listeners.get(serverId);
    if (!serverListeners) {
      serverListeners = new Set();
      this.listeners.set(serverId, serverListeners);
    }
    serverListeners.add(listener);
    return () => {
      serverListeners?.delete(listener);
      if (serverListeners?.size === 0) {
        this.listeners.delete(serverId);
      }
    };
  }
}

function redactIpAddresses(line: string): string {
  return line
    .replace(/\[(?:[0-9a-f:.]+)\](?::\d{1,5})?/gi, '[redacted address]')
    .replace(
      /(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{1,5})?/g,
      '[redacted address]',
    );
}
