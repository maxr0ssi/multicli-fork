import { describe, expect, it, vi } from 'vitest';

import {
  initialRunTarget,
  loadRunTarget,
  runTargetError,
} from '../../../src/studio/client/targetedLaunch.js';
import type { StudioBootstrap, StudioRunView } from '../../../src/studio/contracts/studio.js';

function runView(runId: string, nodeIds: readonly string[]): StudioRunView {
  return {
    run: { id: runId },
    workflow: { nodes: nodeIds.map(id => ({ id })) },
  } as unknown as StudioRunView;
}

describe('Studio targeted launch', () => {
  it('loads an explicit run even when it is older than the 100-run bootstrap', async () => {
    const overview = {
      runs: Array.from({ length: 100 }, (_, index) => ({ id: `recent-${index}` })),
    } as unknown as StudioBootstrap;
    const target = initialRunTarget(overview, { runId: 'archived-run', nodeId: 'review' });
    const api = { run: vi.fn(async () => runView('archived-run', ['review'])) };

    expect(target).toEqual({ runId: 'archived-run', nodeId: 'review' });
    await expect(loadRunTarget(api, target!)).resolves.toMatchObject({
      view: { run: { id: 'archived-run' } },
      nodeId: 'review',
    });
    expect(api.run).toHaveBeenCalledWith('archived-run');
  });

  it('uses the newest summary only when the URL does not target a run', () => {
    const overview = { runs: [{ id: 'newest' }] } as unknown as StudioBootstrap;

    expect(initialRunTarget(overview, { nodeId: 'orphan' })).toEqual({ runId: 'newest' });
  });

  it('preserves a valid run and node URL through target validation', async () => {
    const target = { runId: 'run-7', nodeId: 'builder-2' };

    await expect(loadRunTarget({
      run: vi.fn(async () => runView('run-7', ['plan', 'builder-2'])),
    }, target)).resolves.toEqual({
      view: runView('run-7', ['plan', 'builder-2']),
      nodeId: 'builder-2',
    });
  });

  it('drops an invalid node honestly without replacing the requested run', async () => {
    const loaded = await loadRunTarget({
      run: vi.fn(async () => runView('run-7', ['plan'])),
    }, { runId: 'run-7', nodeId: 'missing-node' });

    expect(loaded.view.run.id).toBe('run-7');
    expect(loaded.nodeId).toBeUndefined();
    expect(loaded.nodeIssue).toContain('Node "missing-node" is not part of run "run-7"');
  });

  it('describes an unknown explicit run instead of implying a fallback', () => {
    expect(runTargetError('missing-run', new Error('Unknown run: missing-run'))).toBe(
      'Could not open requested run "missing-run". Unknown run: missing-run',
    );
  });
});
