import { describe, expect, it } from 'vitest';

import { runFocusItems } from '../../../src/studio/client/features/runs/focusModel.js';
import type { StudioRunView } from '../../../src/studio/contracts/studio.js';

function view(overrides: Partial<StudioRunView> = {}): StudioRunView {
  return {
    run: { status: 'running' },
    workflow: { logicalRevision: 2, nodes: [{}, {}, {}] },
    approvals: [],
    artifacts: [],
    events: [],
    execution: {
      budget: {
        usage: { modelCalls: 0, nodeAttempts: 0, usageReports: 0 },
      },
    },
    ...overrides,
  } as unknown as StudioRunView;
}

describe('run focus model', () => {
  it('always exposes the workflow and omits empty secondary surfaces', () => {
    expect(runFocusItems(view())).toEqual([{
      id: 'workflow',
      label: 'Workflow',
      detail: '3 nodes · revision 2',
      state: 'running',
    }]);
  });

  it('offers usage as a focus surface only after real work has been counted', () => {
    const items = runFocusItems(view({
      execution: {
        budget: {
          usage: { modelCalls: 3, nodeAttempts: 4, usageReports: 1 },
        },
      } as StudioRunView['execution'],
    }));

    expect(items.at(-1)).toEqual({
      id: 'telemetry',
      label: 'Usage',
      detail: '1/3 provider reports',
      state: 'neutral',
    });
  });

  it('exposes only real approvals, outputs, and activity with exact counts', () => {
    const items = runFocusItems(view({
      approvals: [
        { status: 'approved' },
        { status: 'pending' },
      ] as StudioRunView['approvals'],
      artifacts: [{}, {}] as StudioRunView['artifacts'],
      events: [{}, {}, {}] as StudioRunView['events'],
    }));

    expect(items.map(item => [item.id, item.detail, item.state])).toEqual([
      ['workflow', '3 nodes · revision 2', 'running'],
      ['approvals', '1 pending decision', 'waiting'],
      ['outputs', '2 committed artifacts', 'neutral'],
      ['activity', '3 durable events', 'neutral'],
    ]);
  });
});
