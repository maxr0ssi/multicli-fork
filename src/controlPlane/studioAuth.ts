import { randomBytes, timingSafeEqual } from 'node:crypto';
import { requireSafeLocalIdentifier } from '../utils/safeIdentifier.js';

export const STUDIO_SESSION_COOKIE = 'multicli_studio_session';

export interface StudioAuthPrincipal {
  kind: 'bearer' | 'studio';
  csrfToken?: string;
  expiresAt?: string;
}

export interface StudioSession {
  id: string;
  csrfToken: string;
  expiresAt: string;
  /** Same-origin Studio location selected before the nonce was minted. */
  returnTo?: string;
}

export interface StudioLaunchTarget {
  draftId?: string;
  runId?: string;
  nodeId?: string;
}

export interface StudioAuthOptions {
  bearerToken: string;
  launchNonceTtlMs?: number;
  sessionTtlMs?: number;
  now?: () => number;
  createToken?: () => string;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of header?.split(';') ?? []) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name || !value) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // Invalid cookie encoding is treated as an absent cookie.
    }
  }
  return cookies;
}

export class StudioAuthManager {
  readonly #bearerToken: string;
  readonly #launchNonceTtlMs: number;
  readonly #sessionTtlMs: number;
  readonly #now: () => number;
  readonly #createToken: () => string;
  readonly #launchNonces = new Map<string, { expiresAtMs: number; returnTo?: string }>();
  readonly #sessions = new Map<string, { csrfToken: string; expiresAtMs: number }>();

  constructor(options: StudioAuthOptions) {
    if (!options.bearerToken.trim()) {
      throw new Error('Studio authentication requires a bearer token');
    }
    this.#bearerToken = options.bearerToken;
    this.#launchNonceTtlMs = options.launchNonceTtlMs ?? 60_000;
    this.#sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
    this.#now = options.now ?? Date.now;
    this.#createToken = options.createToken
      ?? (() => randomBytes(32).toString('base64url'));
  }

  issueLaunchNonce(target: StudioLaunchTarget = {}): string {
    this.#sweep();
    if (target.draftId && target.runId) {
      throw new Error('A Studio launch may target either a draft or a run, not both');
    }
    if (target.nodeId && !target.runId) {
      throw new Error('A Studio node launch also requires a run id');
    }
    const search = new URLSearchParams();
    for (const [name, value] of [
      ['draft', target.draftId],
      ['run', target.runId],
      ['node', target.nodeId],
    ] as const) {
      if (value) search.set(name, requireSafeLocalIdentifier(value, `${name} id`));
    }
    const returnTo = search.size ? `/studio?${search.toString()}` : undefined;
    const nonce = this.#uniqueToken(this.#launchNonces);
    this.#launchNonces.set(nonce, {
      expiresAtMs: this.#now() + this.#launchNonceTtlMs,
      ...(returnTo ? { returnTo } : {}),
    });
    return nonce;
  }

  exchangeLaunchNonce(nonce: string): StudioSession | undefined {
    this.#sweep();
    const launch = this.#launchNonces.get(nonce);
    if (!launch || launch.expiresAtMs <= this.#now()) {
      this.#launchNonces.delete(nonce);
      return undefined;
    }
    this.#launchNonces.delete(nonce);

    const id = this.#uniqueToken(this.#sessions);
    const csrfToken = this.#createToken();
    const expiresAtMs = this.#now() + this.#sessionTtlMs;
    this.#sessions.set(id, { csrfToken, expiresAtMs });
    return {
      id,
      csrfToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
      ...(launch.returnTo ? { returnTo: launch.returnTo } : {}),
    };
  }

  authenticate(
    authorizationHeader: string | undefined,
    cookieHeader: string | undefined,
  ): StudioAuthPrincipal | undefined {
    this.#sweep();
    if (authorizationHeader?.startsWith('Bearer ')) {
      const provided = authorizationHeader.slice('Bearer '.length);
      if (safeEqual(provided, this.#bearerToken)) {
        return { kind: 'bearer' };
      }
    }

    const sessionId = parseCookies(cookieHeader).get(STUDIO_SESSION_COOKIE);
    if (!sessionId) return undefined;
    const session = this.#sessions.get(sessionId);
    if (!session || session.expiresAtMs <= this.#now()) {
      this.#sessions.delete(sessionId);
      return undefined;
    }
    return {
      kind: 'studio',
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
    };
  }

  verifyCsrf(principal: StudioAuthPrincipal, provided: string | undefined): boolean {
    if (principal.kind === 'bearer') return true;
    return !!principal.csrfToken && !!provided && safeEqual(principal.csrfToken, provided);
  }

  revoke(cookieHeader: string | undefined): void {
    const sessionId = parseCookies(cookieHeader).get(STUDIO_SESSION_COOKIE);
    if (sessionId) this.#sessions.delete(sessionId);
  }

  sessionCookie(session: StudioSession): string {
    const maxAgeSeconds = Math.max(1, Math.floor(this.#sessionTtlMs / 1000));
    return `${STUDIO_SESSION_COOKIE}=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
  }

  clearSessionCookie(): string {
    return `${STUDIO_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  close(): void {
    this.#launchNonces.clear();
    this.#sessions.clear();
  }

  #sweep(): void {
    const now = this.#now();
    for (const [nonce, launch] of this.#launchNonces) {
      if (launch.expiresAtMs <= now) this.#launchNonces.delete(nonce);
    }
    for (const [sessionId, session] of this.#sessions) {
      if (session.expiresAtMs <= now) this.#sessions.delete(sessionId);
    }
  }

  #uniqueToken<T>(records: Map<string, T>): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = this.#createToken();
      if (token && !records.has(token)) return token;
    }
    throw new Error('Unable to allocate a unique Studio credential');
  }
}
