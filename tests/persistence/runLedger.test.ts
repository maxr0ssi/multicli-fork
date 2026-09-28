import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SqliteRunLedger,
  createInMemoryRunLedger,
} from '../../src/persistence/runLedger.js';

const openLedgers: SqliteRunLedger[] = [];
const temporaryDirectories: string[] = [];

function memoryLedger(): SqliteRunLedger {
  const ledger = createInMemoryRunLedger();
  openLedgers.push(ledger);
  return ledger;
}

function seedRun(ledger: SqliteRunLedger): string {
  const revision = ledger.recordWorkflowRevision({
    workflowId: 'luna-build-council',
    definition: { nodes: [{ id: 'plan', type: 'agent' }] },
  });
  return ledger.createRun({
    workflowRevisionId: revision.id,
    workspace: process.cwd(),
    input: { objective: 'Build Multi-CLI' },
  }).id;
}

afterEach(() => {
  for (const ledger of openLedgers.splice(0)) {
    ledger.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SqliteRunLedger', () => {
  it('records immutable workflow revisions and deduplicates identical content', () => {
    const ledger = memoryLedger();
    const first = ledger.recordWorkflowRevision({
      workflowId: 'council',
      definition: { b: 2, a: 1 },
    });
    const second = ledger.recordWorkflowRevision({
      workflowId: 'council',
      definition: { a: 1, b: 2 },
    });

    expect(second.id).toBe(first.id);
    expect(second.contentHash).toBe(first.contentHash);
    expect(ledger.getWorkflowRevision(first.id)?.definition).toEqual({ b: 2, a: 1 });
  });

  it('rejects caller-supplied run ids that are unsafe for local artifact paths', () => {
    const ledger = memoryLedger();
    const revision = ledger.recordWorkflowRevision({
      workflowId: 'safe-run-id',
      definition: { nodes: [] },
    });

    expect(() => ledger.createRun({
      id: '../../escaped-run',
      workflowRevisionId: revision.id,
      workspace: process.cwd(),
    })).toThrow(/must start with a letter or number/i);
  });

  it('appends ordered events and materializes run status atomically', () => {
    const ledger = memoryLedger();
    const runId = seedRun(ledger);

    const started = ledger.appendEvent(runId, 'run.started', { by: 'sol' }, {
      expectedSequence: 0,
    });
    const completed = ledger.appendEvent(runId, 'run.completed', { ok: true }, {
      expectedSequence: 1,
    });

    expect([started.sequence, completed.sequence]).toEqual([1, 2]);
    expect(ledger.getRun(runId)).toMatchObject({ status: 'completed', lastSequence: 2 });
    expect(ledger.listEvents(runId).map(event => event.type)).toEqual([
      'run.started',
      'run.completed',
    ]);
  });

  it('rolls back the run row when the atomic start event cannot be inserted', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-atomic-start-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'runs.sqlite');
    const ledger = new SqliteRunLedger(databasePath);
    openLedgers.push(ledger);
    const revision = ledger.recordWorkflowRevision({
      workflowId: 'atomic-start',
      definition: { nodes: [] },
    });
    const sabotage = new DatabaseSync(databasePath);
    sabotage.exec(`
      CREATE TRIGGER reject_run_start
      BEFORE INSERT ON run_events
      BEGIN
        SELECT RAISE(ABORT, 'forced start-event failure');
      END;
    `);
    sabotage.close();

    expect(() => ledger.createStartedRun({
      id: 'atomic-run',
      workflowRevisionId: revision.id,
      workspace: process.cwd(),
    }, { workflowId: revision.workflowId })).toThrow(/forced start-event failure/);
    expect(ledger.getRun('atomic-run')).toBeUndefined();
  });

  it('rejects stale sequence writers and deduplicates idempotent events', () => {
    const ledger = memoryLedger();
    const runId = seedRun(ledger);

    const first = ledger.appendEvent(runId, 'node.started', { nodeId: 'plan' }, {
      idempotencyKey: 'plan:attempt-1:start',
    });
    const duplicate = ledger.appendEvent(runId, 'node.started', { ignored: true }, {
      idempotencyKey: 'plan:attempt-1:start',
    });

    expect(duplicate).toEqual(first);
    expect(() => ledger.appendEvent(runId, 'node.completed', {}, {
      expectedSequence: 0,
    })).toThrow(/sequence conflict/);
    expect(ledger.listEvents(runId)).toHaveLength(1);
  });

  it('binds approvals to an exact action hash and records their events', () => {
    const ledger = memoryLedger();
    const runId = seedRun(ledger);
    const approval = ledger.requestApproval({
      runId,
      actionHash: 'sha256:approved-action',
      risk: 'workspace-write',
      payload: { command: ['npm', 'test'] },
    });

    expect(() => ledger.resolveApproval({
      id: approval.id,
      decision: 'approved',
      decisionBy: 'max',
      actionHash: 'sha256:changed-action',
    })).toThrow(/action hash changed/);

    const resolved = ledger.resolveApproval({
      id: approval.id,
      decision: 'approved',
      decisionBy: 'max',
      actionHash: approval.actionHash,
    });
    expect(resolved).toMatchObject({ status: 'approved', decisionBy: 'max' });
    expect(ledger.listPendingApprovals()).toEqual([]);
    expect(ledger.listEvents(runId).map(event => event.type)).toEqual([
      'approval.requested',
      'approval.resolved',
    ]);
  });

  it('stores artifact provenance and appends an artifact event', () => {
    const ledger = memoryLedger();
    const runId = seedRun(ledger);
    const artifact = ledger.recordArtifact({
      runId,
      contentHash: 'sha256:artifact',
      mediaType: 'text/markdown',
      name: 'design.md',
      location: 'artifacts/design.md',
      metadata: { redacted: true },
    });

    expect(ledger.listArtifacts(runId)).toEqual([artifact]);
    expect(ledger.listEvents(runId)[0]).toMatchObject({
      type: 'artifact.created',
      payload: { artifactId: artifact.id },
    });
  });

  it('commits approval expiry as a durable non-pending decision', () => {
    const ledger = memoryLedger();
    const runId = seedRun(ledger);
    const approval = ledger.requestApproval({
      runId,
      actionHash: 'sha256:expired',
      risk: 'network',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const expired = ledger.resolveApproval({
      id: approval.id,
      decision: 'approved',
      decisionBy: 'max',
      actionHash: approval.actionHash,
    });

    expect(expired.status).toBe('expired');
    expect(ledger.getApproval(approval.id)?.status).toBe('expired');
    expect(ledger.listPendingApprovals(runId)).toEqual([]);
    expect(ledger.listEvents(runId).at(-1)?.type).toBe('approval.expired');
  });

  it('atomically expires pending approvals when their run becomes terminal', () => {
    const ledger = memoryLedger();
    const runId = seedRun(ledger);
    ledger.appendEvent(runId, 'run.started');
    const approval = ledger.requestApproval({
      runId,
      actionHash: 'sha256:terminal',
      risk: 'workflow-completion',
    });

    ledger.appendEvent(runId, 'run.failed', { reason: 'review failed' });

    expect(ledger.getApproval(approval.id)).toMatchObject({ status: 'expired' });
    expect(ledger.listPendingApprovals(runId)).toEqual([]);
    expect(ledger.listEvents(runId).slice(-2).map(event => event.type)).toEqual([
      'run.failed',
      'approval.expired',
    ]);
    expect(ledger.listEvents(runId).at(-1)?.payload).toMatchObject({
      approvalId: approval.id,
      reason: 'run-terminal',
      runStatus: 'failed',
    });
  });

  it('rejects new terminal-run mutations while releasing an orphaned terminal lease without an event', () => {
    const ledger = memoryLedger();
    const runId = seedRun(ledger);
    ledger.appendEvent(runId, 'run.started');
    const attempt = ledger.scheduleNodeAttempt({
      runId,
      nodeId: 'plan',
      idempotencyKey: `${runId}:plan:1`,
    });
    ledger.claimNodeAttempt({
      id: attempt.id,
      workerId: 'worker-a',
      leaseMs: 60_000,
      now: '2026-08-09T12:00:00.000Z',
    });
    ledger.appendEvent(runId, 'run.cancelled');
    const terminalSequence = ledger.getRun(runId)!.lastSequence;

    expect(() => ledger.appendEvent(runId, 'node.started')).toThrow(/terminal/);
    expect(() => ledger.scheduleNodeAttempt({
      runId,
      nodeId: 'another-node',
      idempotencyKey: `${runId}:another-node:1`,
    })).toThrow(/terminal/);
    expect(() => ledger.recordArtifact({
      runId,
      contentHash: 'sha256:late-artifact',
      mediaType: 'text/plain',
      name: 'late.txt',
      location: 'artifacts/late.txt',
    })).toThrow(/terminal/);

    expect(ledger.recoverExpiredNodeAttempts('2026-08-09T12:00:01.000Z')).toEqual([
      expect.objectContaining({
        id: attempt.id,
        status: 'cancelled',
        error: 'Run is terminal; lease released without committing a result',
      }),
    ]);
    const recoveredAttempt = ledger.getNodeAttempt(attempt.id);
    expect(recoveredAttempt?.status).toBe('cancelled');
    expect(recoveredAttempt?.leaseOwner).toBeUndefined();
    expect(recoveredAttempt?.leaseExpiresAt).toBeUndefined();
    expect(ledger.getRun(runId)).toMatchObject({
      status: 'cancelled',
      lastSequence: terminalSequence,
    });
  });

  it('fails closed when a worker completes after its lease expired', () => {
    const ledger = memoryLedger();
    const runId = seedRun(ledger);
    ledger.appendEvent(runId, 'run.started');
    const attempt = ledger.scheduleNodeAttempt({
      runId,
      nodeId: 'plan',
      idempotencyKey: `${runId}:plan:1`,
    });
    ledger.claimNodeAttempt({
      id: attempt.id,
      workerId: 'worker-a',
      leaseMs: 1_000,
      now: '2026-08-09T12:00:00.000Z',
    });

    expect(() => ledger.completeNodeAttempt({
      id: attempt.id,
      workerId: 'worker-a',
      status: 'succeeded',
      now: '2026-08-09T12:00:01.000Z',
    })).toThrow(/lease has expired/);
    expect(ledger.getNodeAttempt(attempt.id)?.status).toBe('running');

    expect(ledger.recoverExpiredNodeAttempts('2026-08-09T12:00:01.001Z')).toEqual([
      expect.objectContaining({
        id: attempt.id,
        status: 'failed',
        error: 'Lease expired; manual retry required',
      }),
    ]);
    expect(() => ledger.completeNodeAttempt({
      id: attempt.id,
      workerId: 'worker-a',
      status: 'succeeded',
    })).toThrow(/not leased/);
  });

  it('renews a live attempt lease from a process heartbeat without emitting noisy events', () => {
    const ledger = memoryLedger();
    const runId = seedRun(ledger);
    ledger.appendEvent(runId, 'run.started');
    const attempt = ledger.scheduleNodeAttempt({
      runId,
      nodeId: 'silent-opus-review',
      idempotencyKey: `${runId}:silent-opus-review:1`,
    });
    ledger.claimNodeAttempt({
      id: attempt.id,
      workerId: 'worker-opus',
      leaseMs: 1_000,
      now: '2026-08-09T12:00:00.000Z',
    });
    const eventCount = ledger.listEvents(runId).length;

    const renewed = ledger.renewNodeAttemptLease({
      id: attempt.id,
      workerId: 'worker-opus',
      leaseMs: 1_000,
      now: '2026-08-09T12:00:00.750Z',
    });

    expect(renewed.leaseExpiresAt).toBe('2026-08-09T12:00:01.750Z');
    expect(ledger.listEvents(runId)).toHaveLength(eventCount);
    expect(() => ledger.completeNodeAttempt({
      id: attempt.id,
      workerId: 'worker-opus',
      status: 'succeeded',
      now: '2026-08-09T12:00:01.500Z',
    })).not.toThrow();
  });

  it('commits provider-reported usage in the terminal attempt event only', () => {
    const ledger = memoryLedger();
    const runId = seedRun(ledger);
    ledger.appendEvent(runId, 'run.started');
    const attempt = ledger.scheduleNodeAttempt({
      runId,
      nodeId: 'reported-usage',
      idempotencyKey: `${runId}:reported-usage:1`,
    });
    ledger.claimNodeAttempt({
      id: attempt.id,
      workerId: 'worker-usage',
      leaseMs: 10_000,
      now: '2026-08-09T12:00:00.000Z',
    });

    ledger.completeNodeAttempt({
      id: attempt.id,
      workerId: 'worker-usage',
      status: 'succeeded',
      usage: {
        inputTokens: 12_000,
        cachedInputTokens: 9_000,
        outputTokens: 640,
      },
      now: '2026-08-09T12:00:01.000Z',
    });

    expect(ledger.listEvents(runId).at(-1)).toMatchObject({
      type: 'node.succeeded',
      payload: {
        nodeId: 'reported-usage',
        usage: {
          inputTokens: 12_000,
          cachedInputTokens: 9_000,
          outputTokens: 640,
        },
      },
    });
    expect(ledger.getNodeAttempt(attempt.id)).not.toHaveProperty('usage');
  });

  it('rejects malformed usage before completing the attempt', () => {
    const ledger = memoryLedger();
    const runId = seedRun(ledger);
    ledger.appendEvent(runId, 'run.started');
    const attempt = ledger.scheduleNodeAttempt({
      runId,
      nodeId: 'invalid-usage',
      idempotencyKey: `${runId}:invalid-usage:1`,
    });
    ledger.claimNodeAttempt({
      id: attempt.id,
      workerId: 'worker-usage',
      leaseMs: 10_000,
    });

    expect(() => ledger.completeNodeAttempt({
      id: attempt.id,
      workerId: 'worker-usage',
      status: 'succeeded',
      usage: { inputTokens: Number.NaN },
    })).toThrow(/usage inputTokens/);
    expect(ledger.getNodeAttempt(attempt.id)?.status).toBe('running');
  });

  it('refuses to revive an expired attempt lease from a late heartbeat', () => {
    const ledger = memoryLedger();
    const runId = seedRun(ledger);
    ledger.appendEvent(runId, 'run.started');
    const attempt = ledger.scheduleNodeAttempt({
      runId,
      nodeId: 'late-heartbeat',
      idempotencyKey: `${runId}:late-heartbeat:1`,
    });
    ledger.claimNodeAttempt({
      id: attempt.id,
      workerId: 'worker-a',
      leaseMs: 1_000,
      now: '2026-08-09T12:00:00.000Z',
    });

    expect(() => ledger.renewNodeAttemptLease({
      id: attempt.id,
      workerId: 'worker-a',
      leaseMs: 1_000,
      now: '2026-08-09T12:00:01.000Z',
    })).toThrow(/lease has expired/);
    expect(ledger.getNodeAttempt(attempt.id)?.leaseExpiresAt)
      .toBe('2026-08-09T12:00:01.000Z');
  });

  it('persists across reopen with private database permissions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-ledger-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'runs.sqlite');
    const first = new SqliteRunLedger(databasePath);
    const runId = seedRun(first);
    first.appendEvent(runId, 'run.started');
    first.close();

    const second = new SqliteRunLedger(databasePath);
    openLedgers.push(second);
    expect(second.getRun(runId)).toMatchObject({ status: 'running', lastSequence: 1 });
    expect(fs.statSync(databasePath).mode & 0o077).toBe(0);
    expect(fs.statSync(directory).mode & 0o077).toBe(0);
  });

  it('does not change permissions on an existing database parent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-ledger-parent-'));
    temporaryDirectories.push(root);
    const sharedParent = path.join(root, 'shared');
    fs.mkdirSync(sharedParent, { mode: 0o755 });
    if (process.platform !== 'win32') fs.chmodSync(sharedParent, 0o755);

    const ledger = new SqliteRunLedger(path.join(sharedParent, 'runs.sqlite'));
    openLedgers.push(ledger);
    seedRun(ledger);

    if (process.platform !== 'win32') {
      expect(fs.statSync(sharedParent).mode & 0o777).toBe(0o755);
      expect(fs.statSync(ledger.databasePath).mode & 0o077).toBe(0);
    }
  });
});
