import { describe, expect, it, vi } from 'vitest';

import { LocalControlPlane } from '../../src/controlPlane/controlPlane.js';
import { createInMemoryRunLedger } from '../../src/persistence/runLedger.js';

function setup() {
  const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
  const revision = controlPlane.publishWorkflow({
    workflowId: 'luna-build-council',
    definition: { nodes: [{ id: 'plan', type: 'agent' }] },
  });
  return { controlPlane, revision };
}

describe('LocalControlPlane', () => {
  it('starts a durable run and returns a complete snapshot', () => {
    const { controlPlane, revision } = setup();
    const snapshot = controlPlane.startRun({
      workflowRevisionId: revision.id,
      runInput: { objective: 'Build it' },
    });

    expect(snapshot.run).toMatchObject({ status: 'running', lastSequence: 1 });
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({ type: 'run.started' });
    expect(snapshot.workflowRevision.id).toBe(revision.id);
    controlPlane.close();
  });

  it('streams appended events to subscribers in committed order', () => {
    const { controlPlane, revision } = setup();
    const runId = controlPlane.startRun({ workflowRevisionId: revision.id }).run.id;
    const listener = vi.fn();
    const unsubscribe = controlPlane.subscribe(runId, listener);

    controlPlane.appendEvent(runId, 'node.started', { nodeId: 'plan' });
    controlPlane.appendEvent(runId, 'node.completed', { nodeId: 'plan' });
    unsubscribe();
    controlPlane.appendEvent(runId, 'run.completed');

    expect(listener.mock.calls.map(call => call[0].sequence)).toEqual([2, 3]);
    controlPlane.close();
  });

  it('supports idempotent cancel and rejects mutation after completion', () => {
    const { controlPlane, revision } = setup();
    const runId = controlPlane.startRun({ workflowRevisionId: revision.id }).run.id;

    expect(controlPlane.cancelRun(runId).run.status).toBe('cancelled');
    expect(controlPlane.cancelRun(runId).events.filter(
      event => event.type === 'run.cancelled',
    )).toHaveLength(1);
    expect(() => controlPlane.appendEvent(runId, 'node.started')).toThrow(/terminal/);
    expect(() => controlPlane.pauseRun(runId)).toThrow(/terminal/);
    controlPlane.close();
  });

  it('leases node attempts to one worker and fails closed after expiry', () => {
    const { controlPlane, revision } = setup();
    const runId = controlPlane.startRun({ workflowRevisionId: revision.id }).run.id;
    const attempt = controlPlane.scheduleNodeAttempt({
      runId,
      nodeId: 'plan',
      idempotencyKey: `${runId}:plan:1`,
    });
    const claimed = controlPlane.claimNodeAttempt({
      id: attempt.id,
      workerId: 'worker-a',
      leaseMs: 1_000,
      now: '2026-08-09T12:00:00.000Z',
    });
    expect(claimed).toMatchObject({ status: 'running', leaseOwner: 'worker-a' });
    expect(controlPlane.claimNodeAttempt({
      id: attempt.id,
      workerId: 'worker-b',
      leaseMs: 1_000,
      now: '2026-08-09T12:00:00.500Z',
    })).toBeUndefined();

    expect(controlPlane.recoverExpiredNodeAttempts('2026-08-09T12:00:01.001Z')[0]).toMatchObject({
      status: 'failed',
      error: 'Lease expired; manual retry required',
    });
    expect(controlPlane.claimNodeAttempt({
      id: attempt.id,
      workerId: 'worker-b',
      leaseMs: 1_000,
      now: '2026-08-09T12:00:01.002Z',
    })).toBeUndefined();
    expect(() => controlPlane.completeNodeAttempt({
      id: attempt.id,
      workerId: 'worker-a',
      status: 'succeeded',
    })).toThrow(/not leased/);
    controlPlane.close();
  });

  it('records approval and artifact events for live subscribers', () => {
    const { controlPlane, revision } = setup();
    const runId = controlPlane.startRun({ workflowRevisionId: revision.id }).run.id;
    const observed: string[] = [];
    controlPlane.subscribe(runId, event => observed.push(event.type));

    const approval = controlPlane.requestApproval({
      runId,
      actionHash: 'hash:1',
      risk: 'workspace-write',
    });
    controlPlane.resolveApproval({
      id: approval.id,
      decision: 'approved',
      decisionBy: 'max',
      actionHash: approval.actionHash,
    });
    controlPlane.recordArtifact({
      runId,
      contentHash: 'hash:artifact',
      mediaType: 'text/plain',
      name: 'result.txt',
      location: 'artifacts/result.txt',
    });

    expect(observed).toEqual([
      'approval.requested',
      'approval.resolved',
      'artifact.created',
    ]);
    controlPlane.close();
  });

  it('streams approval expiry when a run becomes terminal', () => {
    const { controlPlane, revision } = setup();
    const runId = controlPlane.startRun({ workflowRevisionId: revision.id }).run.id;
    const observed: string[] = [];
    controlPlane.subscribe(runId, event => observed.push(event.type));
    const approval = controlPlane.requestApproval({
      runId,
      actionHash: 'hash:terminal',
      risk: 'workflow-completion',
    });

    controlPlane.appendEvent(runId, 'run.failed', { reason: 'proof' });

    expect(observed.slice(-2)).toEqual(['run.failed', 'approval.expired']);
    expect(controlPlane.ledger.getApproval(approval.id)?.status).toBe('expired');
    expect(controlPlane.getRunSnapshot(runId).approvals).toEqual([]);
    controlPlane.close();
  });
});
