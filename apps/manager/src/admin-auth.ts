import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import type { PlatformRole, UserSnapshot } from '@craftdock/shared';
import type { ControlPlane, UserAccount } from './control-plane.js';

const SESSION_COOKIE = 'craftdock_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const MAX_LOGIN_ATTEMPTS = 5;

export interface AdminSession {
  id: string;
  accountId: string;
  email: string;
  role: PlatformRole;
  csrfToken: string;
  expiresAt: number;
}

export class AdminAuth {
  private readonly controlPlane: ControlPlane;
  private readonly secureCookie: boolean;
  private readonly publicOrigin: string;
  private readonly now: () => number;
  private readonly sessions = new Map<string, AdminSession>();
  private readonly loginAttempts = new Map<string, { startedAt: number; count: number }>();

  constructor(
    controlPlane: ControlPlane,
    options: { secureCookie: boolean; publicOrigin: string; now?: () => number },
  ) {
    this.controlPlane = controlPlane;
    this.secureCookie = options.secureCookie;
    this.publicOrigin = new URL(options.publicOrigin).origin;
    this.now = options.now ?? Date.now;
  }

  async login(
    email: string,
    password: string,
    remoteAddress: string,
  ): Promise<{ account: UserSnapshot; session: AdminSession; token: string } | null> {
    const now = this.now();
    const attempts = this.loginAttempts.get(remoteAddress);
    if (
      attempts &&
      now - attempts.startedAt < LOGIN_WINDOW_MS &&
      attempts.count >= MAX_LOGIN_ATTEMPTS
    ) {
      return null;
    }

    const account = await this.controlPlane.getUserByEmail(email);
    let accepted = false;
    if (account?.status === 'ACTIVE') {
      try {
        accepted = await verify(account.passwordHash, password);
      } catch {
        accepted = false;
      }
    }
    if (!accepted || !account || account.status !== 'ACTIVE') {
      const current = this.loginAttempts.get(remoteAddress);
      if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
        this.loginAttempts.set(remoteAddress, { startedAt: now, count: 1 });
      } else {
        current.count += 1;
      }
      await this.controlPlane.recordAudit('auth.login.failed', null, 'user', email.toLowerCase());
      return null;
    }

    this.loginAttempts.delete(remoteAddress);
    this.pruneExpiredSessions(now);
    this.pruneLoginAttempts(now);
    const token = randomBytes(32).toString('base64url');
    const session: AdminSession = {
      id: createHash('sha256').update(token).digest('hex'),
      accountId: account.id,
      email: account.email,
      role: account.role,
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(session.id, session);
    if (this.sessions.size > 1_000) {
      const oldestId = this.sessions.keys().next().value;
      if (oldestId) {
        this.sessions.delete(oldestId);
      }
    }
    await this.controlPlane.recordAudit('auth.login.succeeded', account.id, 'user', account.id);
    return {
      account: {
        id: account.id,
        email: account.email,
        role: account.role,
        status: account.status,
        createdAt: account.createdAt,
      },
      session,
      token,
    };
  }

  authenticate(cookieHeader: string | undefined): AdminSession | null {
    const token = this.readCookie(cookieHeader);
    if (!token) {
      return null;
    }
    const session = this.sessions.get(createHash('sha256').update(token).digest('hex'));
    if (!session || session.expiresAt <= this.now()) {
      if (session) {
        this.sessions.delete(session.id);
      }
      return null;
    }
    return session;
  }

  validateMutation(
    session: AdminSession,
    origin: string | undefined,
    csrfToken: string | undefined,
  ): boolean {
    if (!this.isAllowedOrigin(origin)) {
      return false;
    }
    if (!csrfToken) {
      return false;
    }
    return safeTokenEquals(csrfToken, session.csrfToken);
  }

  isAllowedOrigin(origin: string | undefined): boolean {
    return !origin || origin === this.publicOrigin;
  }

  cookie(token: string, expiresAt: number): string {
    const maxAge = Math.max(0, Math.floor((expiresAt - this.now()) / 1_000));
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secureCookie ? '; Secure' : ''}`;
  }

  clearCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secureCookie ? '; Secure' : ''}`;
  }

  remove(session: AdminSession): void {
    this.sessions.delete(session.id);
  }

  revokeUser(userId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.accountId === userId) this.sessions.delete(id);
    }
  }

  async changePassword(
    session: AdminSession,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const account: UserAccount | null = await this.controlPlane.getUserById(session.accountId);
    if (!account || account.status !== 'ACTIVE') return false;
    let accepted = false;
    try {
      accepted = await verify(account.passwordHash, currentPassword);
    } catch {
      accepted = false;
    }
    if (!accepted) return false;
    const passwordHash = await hash(newPassword, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });
    await this.controlPlane.updateOwnPassword(session.accountId, passwordHash);
    await this.controlPlane.recordAudit('auth.password.changed', session.accountId, 'user', session.accountId);
    return true;
  }

  private readCookie(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) {
      return null;
    }
    for (const part of cookieHeader.split(';')) {
      const [name, ...valueParts] = part.trim().split('=');
      if (name === SESSION_COOKIE) {
        try {
          return decodeURIComponent(valueParts.join('='));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  private pruneExpiredSessions(now: number): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }

  private pruneLoginAttempts(now: number): void {
    for (const [address, attempts] of this.loginAttempts) {
      if (now - attempts.startedAt >= LOGIN_WINDOW_MS) {
        this.loginAttempts.delete(address);
      }
    }
    if (this.loginAttempts.size > 1_000) {
      const oldestAddress = this.loginAttempts.keys().next().value;
      if (oldestAddress) {
        this.loginAttempts.delete(oldestAddress);
      }
    }
  }
}

function safeTokenEquals(candidate: string, expected: string): boolean {
  const candidateHash = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateHash, expectedHash);
}
