import { describe, expect, it } from 'vitest';

import {
  STUDIO_SESSION_COOKIE,
  StudioAuthManager,
} from '../../src/controlPlane/studioAuth.js';

function setup() {
  let now = Date.parse('2026-08-09T12:00:00.000Z');
  let token = 0;
  const auth = new StudioAuthManager({
    bearerToken: 'local-secret',
    launchNonceTtlMs: 1_000,
    sessionTtlMs: 10_000,
    now: () => now,
    createToken: () => `token-${token += 1}`,
  });
  return {
    auth,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

describe('StudioAuthManager', () => {
  it('exchanges a launch nonce exactly once for an HttpOnly session', () => {
    const { auth } = setup();
    const nonce = auth.issueLaunchNonce();
    const session = auth.exchangeLaunchNonce(nonce);

    expect(session).toMatchObject({ id: 'token-2', csrfToken: 'token-3' });
    expect(auth.exchangeLaunchNonce(nonce)).toBeUndefined();
    expect(auth.sessionCookie(session!)).toContain(
      `${STUDIO_SESSION_COOKIE}=token-2; HttpOnly; SameSite=Strict; Path=/`,
    );
  });

  it('binds a safe Studio destination to the nonce without creating an open redirect', () => {
    const { auth } = setup();
    const session = auth.exchangeLaunchNonce(auth.issueLaunchNonce({
      runId: 'run-1',
      nodeId: 'review-1',
    }));

    expect(session?.returnTo).toBe('/studio?run=run-1&node=review-1');
    expect(() => auth.issueLaunchNonce({ draftId: '../../escape' })).toThrow(/draft id/);
    expect(() => auth.issueLaunchNonce({ nodeId: 'review-1' })).toThrow(/requires a run/);
  });

  it('expires unused launch nonces and browser sessions', () => {
    const { auth, advance } = setup();
    const expiredNonce = auth.issueLaunchNonce();
    advance(1_001);
    expect(auth.exchangeLaunchNonce(expiredNonce)).toBeUndefined();

    const session = auth.exchangeLaunchNonce(auth.issueLaunchNonce())!;
    expect(auth.authenticate(undefined, `${STUDIO_SESSION_COOKIE}=${session.id}`)).toMatchObject({
      kind: 'studio',
    });
    advance(10_001);
    expect(auth.authenticate(undefined, `${STUDIO_SESSION_COOKIE}=${session.id}`)).toBeUndefined();
  });

  it('accepts the CLI bearer without CSRF and requires CSRF for browser sessions', () => {
    const { auth } = setup();
    const bearer = auth.authenticate('Bearer local-secret', undefined)!;
    expect(bearer).toEqual({ kind: 'bearer' });
    expect(auth.verifyCsrf(bearer, undefined)).toBe(true);

    expect(auth.authenticate('Bearer wrong', undefined)).toBeUndefined();
    const session = auth.exchangeLaunchNonce(auth.issueLaunchNonce())!;
    const browser = auth.authenticate(
      undefined,
      `${STUDIO_SESSION_COOKIE}=${session.id}`,
    )!;
    expect(auth.verifyCsrf(browser, 'wrong')).toBe(false);
    expect(auth.verifyCsrf(browser, session.csrfToken)).toBe(true);
  });

  it('revokes a browser session and emits an immediate-expiry cookie', () => {
    const { auth } = setup();
    const session = auth.exchangeLaunchNonce(auth.issueLaunchNonce())!;
    const cookie = `${STUDIO_SESSION_COOKIE}=${session.id}`;
    auth.revoke(cookie);

    expect(auth.authenticate(undefined, cookie)).toBeUndefined();
    expect(auth.clearSessionCookie()).toContain('Max-Age=0');
  });
});
