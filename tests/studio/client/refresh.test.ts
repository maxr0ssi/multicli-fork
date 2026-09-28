import { describe, expect, it, vi } from 'vitest';

import {
  mergeSelectedRunView,
  refreshStudio,
} from '../../../src/studio/client/refresh.js';
import type {
  StudioBootstrap,
  StudioRunView,
} from '../../../src/studio/contracts/studio.js';

describe('Studio polling', () => {
  it('refreshes the selected run as well as the run list for silent heartbeat changes', async () => {
    const overview = { runs: [] } as unknown as StudioBootstrap;
    const view = { run: { id: 'selected-run' } } as unknown as StudioRunView;
    const api = {
      overview: vi.fn(async () => overview),
      run: vi.fn(async () => view),
    };

    await expect(refreshStudio(api, 'selected-run')).resolves.toEqual({ overview, view });
    expect(api.run).toHaveBeenCalledWith('selected-run');
  });

  it('does not request a run when the workspace has no selection', async () => {
    const overview = { runs: [] } as unknown as StudioBootstrap;
    const api = {
      overview: vi.fn(async () => overview),
      run: vi.fn(async () => undefined as unknown as StudioRunView),
    };

    await expect(refreshStudio(api)).resolves.toEqual({ overview, view: undefined });
    expect(api.run).not.toHaveBeenCalled();
  });

  it('preserves selection and rejects stale or unrelated poll responses', () => {
    const current = {
      serverTime: '2026-08-09T16:00:00.000Z',
      run: { id: 'selected-run' },
    } as StudioRunView;
    const stale = {
      serverTime: '2026-08-09T15:59:59.000Z',
      run: { id: 'selected-run' },
    } as StudioRunView;
    const unrelated = {
      serverTime: '2026-08-09T16:00:01.000Z',
      run: { id: 'other-run' },
    } as StudioRunView;

    expect(mergeSelectedRunView(current, stale, 'selected-run')).toBe(current);
    expect(mergeSelectedRunView(current, unrelated, 'selected-run')).toBe(current);
  });
});
