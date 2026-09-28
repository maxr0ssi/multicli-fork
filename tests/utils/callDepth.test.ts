import { describe, it, expect } from 'vitest';

import {
  assertCallDepthAvailable,
  childEnv,
  getCallDepth,
  getMaxCallDepth,
} from '../../src/utils/callDepth.js';

describe('callDepth', () => {
  it('treats a missing or malformed depth as the top of the chain', () => {
    expect(getCallDepth({})).toBe(0);
    expect(getCallDepth({ MULTICLI_DEPTH: 'nonsense' })).toBe(0);
    expect(getCallDepth({ MULTICLI_DEPTH: '-4' })).toBe(0);
    expect(getCallDepth({ MULTICLI_DEPTH: '2' })).toBe(2);
  });

  it('defaults the ceiling and honours an override', () => {
    expect(getMaxCallDepth({})).toBe(3);
    expect(getMaxCallDepth({ MULTICLI_MAX_DEPTH: '1' })).toBe(1);
    expect(getMaxCallDepth({ MULTICLI_MAX_DEPTH: 'nope' })).toBe(3);
  });

  it('allows a call below the ceiling', () => {
    expect(() =>
      assertCallDepthAvailable('Codex', { MULTICLI_DEPTH: '2', MULTICLI_MAX_DEPTH: '3' }),
    ).not.toThrow();
  });

  it('refuses at and beyond the ceiling', () => {
    for (const depth of ['3', '4']) {
      expect(() =>
        assertCallDepthAvailable('Codex', { MULTICLI_DEPTH: depth, MULTICLI_MAX_DEPTH: '3' }),
      ).toThrow(/Delegation depth limit reached/);
    }
  });

  it('increments the depth carried to the spawned CLI', () => {
    const child = childEnv(undefined, { MULTICLI_DEPTH: '1', MULTICLI_MAX_DEPTH: '3' });
    expect(child.MULTICLI_DEPTH).toBe('2');
    // The ceiling must travel too, or a nested server would fall back to the default.
    expect(child.MULTICLI_MAX_DEPTH).toBe('3');
  });

  it('preserves the caller-supplied environment', () => {
    const child = childEnv({ PATH: '/usr/bin', CUSTOM: 'x' }, { MULTICLI_DEPTH: '0' });
    expect(child.PATH).toBe('/usr/bin');
    expect(child.CUSTOM).toBe('x');
    expect(child.MULTICLI_DEPTH).toBe('1');
  });
});
