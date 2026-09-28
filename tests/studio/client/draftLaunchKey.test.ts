import { describe, expect, it, vi } from 'vitest';

import { stableDraftRunKey } from '../../../src/studio/client/features/editor/draftLaunchKey.js';

describe('draft launch idempotency key', () => {
  it('reuses one run id for retries of the same draft version', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const create = vi.fn(() => 'stable-run-id');

    expect(stableDraftRunKey('draft-1', 4, storage, create)).toBe('stable-run-id');
    expect(stableDraftRunKey('draft-1', 4, storage, create)).toBe('stable-run-id');
    expect(create).toHaveBeenCalledOnce();
  });

  it('also reuses the run id when session storage is unavailable', () => {
    const storage = {
      getItem: () => { throw new Error('storage blocked'); },
      setItem: () => { throw new Error('storage blocked'); },
    };
    const create = vi.fn(() => 'memory-run-id');

    expect(stableDraftRunKey('storage-blocked-draft', 2, storage, create))
      .toBe('memory-run-id');
    expect(stableDraftRunKey('storage-blocked-draft', 2, storage, create))
      .toBe('memory-run-id');
    expect(create).toHaveBeenCalledOnce();
  });
});
