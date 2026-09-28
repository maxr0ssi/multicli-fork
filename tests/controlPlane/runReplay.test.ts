import { describe, expect, it, vi } from 'vitest';

import { LocalControlPlane } from '../../src/controlPlane/controlPlane.js';
import { createInMemoryRunLedger } from '../../src/persistence/runLedger.js';

describe('full durable run replay', () => {
  it('cursor-pages snapshots and persisted-event broadcasts past 10,000 events', () => {
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const revision = controlPlane.publishWorkflow({
      workflowId: 'long-run',
      definition: { id: 'long-run', profiles: [], nodes: [], edges: [] },
    });
    const runId = controlPlane.startRun({
      workflowRevisionId: revision.id,
      workspace: process.cwd(),
    }).run.id;
    for (let index = 0; index < 10_005; index += 1) {
      controlPlane.ledger.appendEvent(runId, 'diagnostic.recorded', { index });
    }

    expect(controlPlane.ledger.listEvents(runId)).toHaveLength(1_000);
    expect(controlPlane.ledger.listAllEvents(runId)).toHaveLength(10_006);
    expect(controlPlane.getRunSnapshot(runId).events).toHaveLength(10_006);
    const listener = vi.fn();
    controlPlane.subscribe(runId, listener);
    expect(controlPlane.emitPersistedEvents(runId, 9_999)).toHaveLength(7);
    expect(listener).toHaveBeenCalledTimes(7);
    expect(listener.mock.calls.at(-1)?.[0].sequence).toBe(10_006);
    listener.mockClear();
    controlPlane.requestApproval({
      runId,
      actionHash: 'long-run-approval',
      risk: 'review',
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toMatchObject({
      sequence: 10_007,
      type: 'approval.requested',
    });
    controlPlane.close();
  });
});
