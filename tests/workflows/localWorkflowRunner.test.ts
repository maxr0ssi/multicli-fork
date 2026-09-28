import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalControlPlane } from '../../src/controlPlane/controlPlane.js';
import { createInMemoryRunLedger } from '../../src/persistence/runLedger.js';
import type { WorkflowProviderExecutor } from '../../src/workflows/executor.js';
import { createLunaBuildCouncilDefinition } from '../../src/workflows/lunaBuildCouncil.js';
import { LocalWorkflowRunner } from '../../src/workflows/runner.js';
import { agent, defineWorkflow, parallel, profiles, sequence } from '../../src/workflows/dsl.js';
import { runRepositoryHarness } from '../../src/harness/repository.js';
import { ProviderExecutionError } from '../../src/workflows/providerUsage.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('LocalWorkflowRunner', () => {
  it('runs at most five read-only agents concurrently by default', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-runner-cap-'));
    temporaryDirectories.push(directory);
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const reviewer = profiles.luna({
      id: 'read-only-luna',
      role: 'reviewer',
      workspaceAccess: 'read-only',
    });
    const revision = defineWorkflow({
      id: 'bounded-readers',
      name: 'Bounded readers',
      steps: sequence(parallel('readers', Array.from({ length: 6 }, (_, index) => (
        agent(`reader-${index + 1}`, reviewer, 'Review.')
      )))),
    });
    const durableRevision = controlPlane.publishWorkflow({
      workflowId: revision.id,
      definition: revision,
    });
    const runId = controlPlane.startRun({
      workflowRevisionId: durableRevision.id, workspace: directory,
    }).run.id;
    let active = 0;
    let maxActive = 0;
    const renewLease = vi.spyOn(controlPlane, 'renewNodeAttemptLease');
    let releaseFirstBatch: () => void = () => undefined;
    const firstBatch = new Promise<void>(resolve => { releaseFirstBatch = resolve; });
    const execute = vi.fn<WorkflowProviderExecutor['execute']>(async request => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      request.onHeartbeat?.();
      if (active === 5) releaseFirstBatch();
      await firstBatch;
      active -= 1;
      return { text: 'reviewed' };
    });
    const runner = new LocalWorkflowRunner({
      controlPlane,
      executor: { execute },
      workspace: directory,
      artifactRoot: path.join(directory, 'artifacts'),
    });

    await runner.execute(runId);

    expect(execute).toHaveBeenCalledTimes(6);
    expect(renewLease).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(5);
    expect(controlPlane.getRunSnapshot(runId).run.status).toBe('completed');
    await runner.close();
    controlPlane.close();
  });

  it('executes Sol then Luna MAX locally, serializes writers, and waits at the review gate', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-runner-'));
    temporaryDirectories.push(directory);
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const revision = createLunaBuildCouncilDefinition({ builderCount: 2 });
    const durableRevision = controlPlane.publishWorkflow({
      workflowId: revision.id,
      definition: revision,
    });
    const runId = controlPlane.startRun({
      workflowRevisionId: durableRevision.id,
      workspace: directory,
      runInput: { objective: 'Build the local orchestration studio' },
    }).run.id;
    let activeWriters = 0;
    let maxActiveWriters = 0;
    const execute = vi.fn<WorkflowProviderExecutor['execute']>(async request => {
      if (request.profile.workspaceAccess === 'workspace-write') {
        activeWriters += 1;
        maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
        await new Promise(resolve => setTimeout(resolve, 2));
        activeWriters -= 1;
      }
      return { text: `Result from ${request.profile.profileId}` };
    });
    const runner = new LocalWorkflowRunner({
      controlPlane,
      executor: { execute },
      workspace: directory,
      artifactRoot: path.join(directory, 'artifacts'),
      leaseMs: 10_000,
      runHarness: workspace => runRepositoryHarness({
        workspace,
        runCheck: async () => ({ status: 'passed', durationMs: 1 }),
      }),
    });

    await runner.execute(runId);

    const waiting = controlPlane.getRunSnapshot(runId);
    expect(waiting.run.status).toBe('waiting');
    expect(waiting.approvals).toHaveLength(1);
    expect(waiting.artifacts).toHaveLength(4);
    expect(waiting.events.map(event => event.type)).toContain('harness.completed');
    expect(execute.mock.calls.map(call => call[0].profile.profileId)).toEqual([
      'sol-conductor',
      'luna-max-builder',
      'luna-max-builder',
      'sol-conductor',
    ]);
    expect(execute.mock.calls.every(call => call[0].profile.model !== 'gpt-5.6-terra')).toBe(true);
    expect(execute.mock.calls.filter(
      call => call[0].profile.profileId === 'luna-max-builder',
    ).every(
      call => call[0].profile.reasoningEffort === 'max',
    )).toBe(true);
    expect(maxActiveWriters).toBe(1);

    const approval = controlPlane.resolveApproval({
      id: waiting.approvals[0].id,
      decision: 'approved',
      decisionBy: 'max',
      actionHash: waiting.approvals[0].actionHash,
    });
    await runner.resolveGateApproval(approval);

    expect(controlPlane.getRunSnapshot(runId).run.status).toBe('completed');
    expect(controlPlane.ledger.listEvents(runId).map(event => event.type)).toContain('gate.resolved');
    controlPlane.close();
  });

  it('fails a workflow after a denied exact-action review gate', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-runner-'));
    temporaryDirectories.push(directory);
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const revision = createLunaBuildCouncilDefinition({ builderCount: 2 });
    const durableRevision = controlPlane.publishWorkflow({
      workflowId: revision.id,
      definition: revision,
    });
    const runId = controlPlane.startRun({
      workflowRevisionId: durableRevision.id, workspace: directory,
    }).run.id;
    const runner = new LocalWorkflowRunner({
      controlPlane,
      executor: { execute: async () => ({ text: 'bounded result' }) },
      workspace: directory,
      artifactRoot: path.join(directory, 'artifacts'),
      runHarness: workspace => runRepositoryHarness({
        workspace,
        runCheck: async () => ({ status: 'passed', durationMs: 1 }),
      }),
    });
    await runner.execute(runId);
    const pending = controlPlane.getRunSnapshot(runId).approvals[0];
    const denied = controlPlane.resolveApproval({
      id: pending.id,
      decision: 'denied',
      decisionBy: 'max',
      actionHash: pending.actionHash,
    });
    await runner.resolveGateApproval(denied);

    expect(controlPlane.getRunSnapshot(runId).run.status).toBe('failed');
    controlPlane.close();
  });

  it('pauses after the active writer without starting another provider call', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-runner-'));
    temporaryDirectories.push(directory);
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const revision = createLunaBuildCouncilDefinition({ builderCount: 2 });
    const durableRevision = controlPlane.publishWorkflow({
      workflowId: revision.id,
      definition: revision,
    });
    const runId = controlPlane.startRun({
      workflowRevisionId: durableRevision.id, workspace: directory,
    }).run.id;
    let releaseWriter: () => void = () => undefined;
    let notifyWriterStarted: () => void = () => undefined;
    const writerStarted = new Promise<void>(resolve => { notifyWriterStarted = resolve; });
    const writerReleased = new Promise<void>(resolve => { releaseWriter = resolve; });
    let writerCalls = 0;
    const runner = new LocalWorkflowRunner({
      controlPlane,
      executor: {
        execute: async request => {
          if (request.profile.workspaceAccess === 'workspace-write') {
            writerCalls += 1;
            if (writerCalls === 1) {
              notifyWriterStarted();
              await writerReleased;
            }
          }
          return { text: `Result from ${request.profile.profileId}` };
        },
      },
      workspace: directory,
      artifactRoot: path.join(directory, 'artifacts'),
      runHarness: workspace => runRepositoryHarness({
        workspace,
        runCheck: async () => ({ status: 'passed', durationMs: 1 }),
      }),
    });

    const execution = runner.execute(runId);
    await writerStarted;
    controlPlane.pauseRun(runId);
    releaseWriter();
    await execution;

    expect(controlPlane.getRunSnapshot(runId).run.status).toBe('waiting');
    expect(writerCalls).toBe(1);
    expect(controlPlane.ledger.listNodeAttempts(runId).map(attempt => attempt.nodeId)).toEqual([
      'luna-builder-1',
      'sol-conductor',
    ]);

    controlPlane.resumeRun(runId);
    await runner.execute(runId);
    expect(writerCalls).toBe(2);
    expect(controlPlane.getRunSnapshot(runId)).toMatchObject({
      run: { status: 'waiting' },
      approvals: [{ status: 'pending' }],
    });
    await runner.close();
    controlPlane.close();
  });

  it('does not append a gate decision after the run became terminal', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-runner-'));
    temporaryDirectories.push(directory);
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const revision = createLunaBuildCouncilDefinition({ builderCount: 2 });
    const durableRevision = controlPlane.publishWorkflow({
      workflowId: revision.id,
      definition: revision,
    });
    const runId = controlPlane.startRun({
      workflowRevisionId: durableRevision.id, workspace: directory,
    }).run.id;
    const approval = controlPlane.requestApproval({
      runId,
      actionHash: 'sha256:gate',
      risk: 'workflow-completion',
      payload: { kind: 'workflow-gate', nodeId: 'review-gate' },
    });
    const resolved = controlPlane.resolveApproval({
      id: approval.id,
      decision: 'approved',
      decisionBy: 'max',
      actionHash: approval.actionHash,
    });
    controlPlane.cancelRun(runId);
    const eventCount = controlPlane.ledger.listEvents(runId).length;
    const runner = new LocalWorkflowRunner({
      controlPlane,
      executor: { execute: async () => ({ text: 'unused' }) },
      workspace: directory,
      artifactRoot: path.join(directory, 'artifacts'),
    });

    await runner.resolveGateApproval(resolved);

    expect(controlPlane.getRunSnapshot(runId).run.status).toBe('cancelled');
    expect(controlPlane.ledger.listEvents(runId)).toHaveLength(eventCount);
    controlPlane.close();
  });

  it('waits for an aborted worker to release its lease during close', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-runner-'));
    temporaryDirectories.push(directory);
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const revision = createLunaBuildCouncilDefinition({ builderCount: 2 });
    const durableRevision = controlPlane.publishWorkflow({
      workflowId: revision.id,
      definition: revision,
    });
    const runId = controlPlane.startRun({
      workflowRevisionId: durableRevision.id, workspace: directory,
    }).run.id;
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>(resolve => {
      notifyStarted = resolve;
    });
    const runner = new LocalWorkflowRunner({
      controlPlane,
      executor: {
        execute: async request => {
          notifyStarted();
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(request.signal?.reason ?? new Error('aborted'));
            if (request.signal?.aborted) {
              abort();
            } else {
              request.signal?.addEventListener('abort', abort, { once: true });
            }
          });
          return { text: 'unreachable' };
        },
      },
      workspace: directory,
      artifactRoot: path.join(directory, 'artifacts'),
      leaseMs: 10_000,
    });

    const execution = runner.execute(runId);
    await started;
    await runner.close();

    await expect(execution).resolves.toBeUndefined();
    const [attempt] = controlPlane.ledger.listNodeAttempts(runId);
    expect(attempt).toMatchObject({
      status: 'failed',
      error: 'Worker stopped before a result was committed.',
    });
    expect(attempt.leaseOwner).toBeUndefined();
    expect(attempt.leaseExpiresAt).toBeUndefined();
    expect(controlPlane.ledger.listEvents(runId).map(event => event.type)).toContain('node.failed');
    await expect(runner.execute(runId)).rejects.toThrow(/closed/);
    controlPlane.close();
  });

  it('commits provider-reported usage even when the provider turn fails', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-runner-usage-'));
    temporaryDirectories.push(directory);
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const revision = defineWorkflow({
      id: 'failed-usage',
      name: 'Failed usage',
      steps: sequence(agent(
        'review',
        profiles.sol({ workspaceAccess: 'read-only' }),
        'Review the work.',
      )),
    });
    const durableRevision = controlPlane.publishWorkflow({
      workflowId: revision.id,
      definition: revision,
    });
    const runId = controlPlane.startRun({
      workflowRevisionId: durableRevision.id, workspace: directory,
    }).run.id;
    const runner = new LocalWorkflowRunner({
      controlPlane,
      executor: {
        execute: async () => {
          throw new ProviderExecutionError('provider failed', {
            usage: { inputTokens: 600, cachedInputTokens: 400, outputTokens: 20 },
          });
        },
      },
      workspace: directory,
      artifactRoot: path.join(directory, 'artifacts'),
    });

    await runner.execute(runId);

    const failed = controlPlane.ledger.listEvents(runId)
      .find(event => event.type === 'node.failed');
    expect(failed?.payload).toMatchObject({
      usage: { inputTokens: 600, cachedInputTokens: 400, outputTokens: 20 },
    });
    expect(controlPlane.getRunSnapshot(runId).run.status).toBe('failed');
    await runner.close();
    controlPlane.close();
  });

});
