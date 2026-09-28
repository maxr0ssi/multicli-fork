import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalControlPlane } from '../../src/controlPlane/controlPlane.js';
import { SqliteRunLedger } from '../../src/persistence/runLedger.js';
import { StudioQueryService } from '../../src/studio/server/studioQueryService.js';
import { runRepositoryHarness } from '../../src/harness/repository.js';
import { agent, approval, defineWorkflow, parallel, profiles, sequence } from '../../src/workflows/dsl.js';
import type { WorkflowProviderExecutor } from '../../src/workflows/executor.js';
import { LocalWorkflowRunner } from '../../src/workflows/runner.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

function testWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-runner-authority-'));
  directories.push(root);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  return { databasePath: path.join(root, 'runs.sqlite'), root, workspace };
}

function writerWorkflow(id: string, count = 1) {
  const writer = profiles.luna({
    id: `${id}-writer`, role: 'builder', workspaceAccess: 'workspace-write',
  });
  const nodes = Array.from({ length: count }, (_, index) => (
    agent(`write-${index + 1}`, writer, `Write ${index + 1}.`)
  ));
  return defineWorkflow({
    id,
    name: id,
    steps: sequence(count === 1 ? nodes[0] : parallel('writers', nodes)),
  });
}

function readerWorkflow(id: string, count: number) {
  const reader = profiles.luna({
    id: `${id}-reader`, role: 'reviewer', workspaceAccess: 'read-only',
  });
  return defineWorkflow({
    id,
    name: id,
    steps: sequence(parallel('readers', Array.from({ length: count }, (_, index) => (
      agent(`read-${index + 1}`, reader, `Read ${index + 1}.`)
    )))),
  });
}

function publishRun(
  controlPlane: LocalControlPlane,
  workspace: string,
  workflow: ReturnType<typeof writerWorkflow> | ReturnType<typeof readerWorkflow>,
) {
  const revision = controlPlane.publishWorkflow({ workflowId: workflow.id, definition: workflow });
  return controlPlane.startRun({ workflowRevisionId: revision.id, workspace }).run.id;
}

function runner(input: {
  controlPlane: LocalControlPlane;
  workspace: string;
  root: string;
  execute: WorkflowProviderExecutor['execute'];
  maxConcurrentAgents?: number;
}) {
  return new LocalWorkflowRunner({
    controlPlane: input.controlPlane,
    workspace: input.workspace,
    artifactRoot: path.join(input.root, 'artifacts'),
    executor: { execute: input.execute },
    leaseMs: 5_000,
    authorityLeaseMs: 300,
    maxConcurrentAgents: input.maxConcurrentAgents,
  });
}

describe('LocalWorkflowRunner durable authority', () => {
  it('keeps a silent leader alive and prevents a second process from driving sibling writers', async () => {
    const { databasePath, root, workspace } = testWorkspace();
    const firstControl = new LocalControlPlane(new SqliteRunLedger(databasePath));
    const secondControl = new LocalControlPlane(new SqliteRunLedger(databasePath));
    const runId = publishRun(firstControl, workspace, writerWorkflow('owned-writers', 2));
    const started = deferred();
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    const firstExecute = vi.fn<WorkflowProviderExecutor['execute']>(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (firstExecute.mock.calls.length === 1) {
        started.resolve();
        await release.promise;
      }
      active -= 1;
      return { text: 'written once' };
    });
    const secondExecute = vi.fn<WorkflowProviderExecutor['execute']>(
      async () => ({ text: 'must not run' }),
    );
    const firstRunner = runner({ controlPlane: firstControl, workspace, root, execute: firstExecute });
    const secondRunner = runner({
      controlPlane: secondControl, workspace, root, execute: secondExecute,
    });
    const firstWork = firstRunner.execute(runId);
    await started.promise;
    await new Promise(resolve => setTimeout(resolve, 450));
    const followerWork = secondRunner.execute(runId);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(secondExecute).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([firstWork, followerWork]);
    expect(firstExecute).toHaveBeenCalledTimes(2);
    expect(secondExecute).not.toHaveBeenCalled();
    expect(maxActive).toBe(1);
    expect(firstControl.getRunSnapshot(runId).run.status).toBe('completed');
    await Promise.all([firstRunner.close(), secondRunner.close()]);
    firstControl.close();
    secondControl.close();
  });

  it('keeps follower-started work pending, then executes it once after leader release', async () => {
    const { databasePath, root, workspace } = testWorkspace();
    const leaderControl = new LocalControlPlane(new SqliteRunLedger(databasePath));
    const followerControl = new LocalControlPlane(new SqliteRunLedger(databasePath));
    const leaderRun = publishRun(leaderControl, workspace, writerWorkflow('leader-run'));
    const followerRun = publishRun(followerControl, workspace, writerWorkflow('follower-run'));
    const started = deferred();
    const release = deferred();
    const leaderExecute = vi.fn<WorkflowProviderExecutor['execute']>(async () => {
      started.resolve();
      await release.promise;
      return { text: 'leader result' };
    });
    const followerExecute = vi.fn<WorkflowProviderExecutor['execute']>(
      async () => ({ text: 'follower result' }),
    );
    const leader = runner({ controlPlane: leaderControl, workspace, root, execute: leaderExecute });
    const follower = runner({
      controlPlane: followerControl, workspace, root, execute: followerExecute,
    });
    const leaderWork = leader.execute(leaderRun);
    await started.promise;
    const followerWork = follower.execute(followerRun);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(followerExecute).not.toHaveBeenCalled();
    expect(followerControl.getRunSnapshot(followerRun).run.status).toBe('running');

    release.resolve();
    await Promise.all([leaderWork, followerWork]);
    expect(followerExecute).toHaveBeenCalledOnce();
    expect(followerControl.getRunSnapshot(followerRun).run.status).toBe('completed');
    await Promise.all([leader.close(), follower.close()]);
    leaderControl.close();
    followerControl.close();
  });

  it('serializes writers and shares the read-only cap across runs in one elected runner', async () => {
    const { databasePath, root, workspace } = testWorkspace();
    const controlPlane = new LocalControlPlane(new SqliteRunLedger(databasePath));
    const writerA = publishRun(controlPlane, workspace, writerWorkflow('writer-a'));
    const writerB = publishRun(controlPlane, workspace, writerWorkflow('writer-b'));
    let activeWriters = 0;
    let maxWriters = 0;
    const executeWriter = vi.fn<WorkflowProviderExecutor['execute']>(async () => {
      activeWriters += 1;
      maxWriters = Math.max(maxWriters, activeWriters);
      await new Promise(resolve => setTimeout(resolve, 10));
      activeWriters -= 1;
      return { text: 'writer result' };
    });
    const elected = runner({ controlPlane, workspace, root, execute: executeWriter });
    await Promise.all([elected.execute(writerA), elected.execute(writerB)]);
    expect(maxWriters).toBe(1);

    const readerA = publishRun(controlPlane, workspace, readerWorkflow('reader-a', 3));
    const readerB = publishRun(controlPlane, workspace, readerWorkflow('reader-b', 3));
    let activeReaders = 0;
    let maxReaders = 0;
    const readerGate = deferred();
    const readersStarted = deferred();
    const executeReader = vi.fn<WorkflowProviderExecutor['execute']>(async () => {
      activeReaders += 1;
      maxReaders = Math.max(maxReaders, activeReaders);
      if (activeReaders === 3) readersStarted.resolve();
      await readerGate.promise;
      activeReaders -= 1;
      return { text: 'reader result' };
    });
    await elected.close();
    const bounded = runner({
      controlPlane, workspace, root, execute: executeReader, maxConcurrentAgents: 3,
    });
    const readerWork = Promise.all([bounded.execute(readerA), bounded.execute(readerB)]);
    await readersStarted.promise;
    expect(maxReaders).toBe(3);
    readerGate.resolve();
    await readerWork;
    expect(executeReader).toHaveBeenCalledTimes(6);
    expect(maxReaders).toBe(3);
    await bounded.close();
    controlPlane.close();
  });

  it('never recovers another workspace or a legacy run without a workspace pin', async () => {
    const { databasePath, root, workspace } = testWorkspace();
    const otherWorkspace = path.join(root, 'other-workspace');
    fs.mkdirSync(otherWorkspace);
    const seedControl = new LocalControlPlane(new SqliteRunLedger(databasePath));
    const foreignRun = publishRun(seedControl, workspace, writerWorkflow('foreign-run'));
    const legacyRun = publishRun(seedControl, workspace, writerWorkflow('legacy-run'));
    seedControl.close();
    const database = new DatabaseSync(databasePath);
    database.prepare('UPDATE runs SET workspace = NULL WHERE id = ?').run(legacyRun);
    database.close();
    const observerControl = new LocalControlPlane(new SqliteRunLedger(databasePath));
    const execute = vi.fn<WorkflowProviderExecutor['execute']>(async () => ({ text: 'unsafe' }));
    const observer = runner({
      controlPlane: observerControl, workspace: otherWorkspace, root, execute,
    });

    await observer.recover();
    await expect(observer.execute(foreignRun)).rejects.toThrow(/runner is pinned/);
    await expect(observer.execute(legacyRun)).rejects.toThrow(/observer-only/);
    expect(() => observerControl.resumeRun(legacyRun)).toThrow(/observer-only/);
    expect(execute).not.toHaveBeenCalled();
    expect(observerControl.getRunSnapshot(foreignRun).events).toHaveLength(1);
    expect(observerControl.getRunSnapshot(legacyRun).run.workspace).toBeUndefined();
    expect(observerControl.ledger.getWorkflowRunnerAuthority(otherWorkspace)).toBeUndefined();
    const legacyView = new StudioQueryService({
      controlPlane: observerControl,
      workspace: otherWorkspace,
    }).getRunView(legacyRun);
    expect(legacyView.run.allowedActions.pause).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/observer-only/),
    });
    expect(legacyView.run.allowedActions.resume).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/observer-only/),
    });
    await observer.close();
    observerControl.close();
  });

  it('keeps ownership until a dead worker lease can be durably reconciled', async () => {
    const { databasePath, root, workspace } = testWorkspace();
    const controlPlane = new LocalControlPlane(new SqliteRunLedger(databasePath));
    const runId = publishRun(controlPlane, workspace, writerWorkflow('dead-worker-run'));
    const attempt = controlPlane.scheduleNodeAttempt({
      runId,
      nodeId: 'write-1',
      idempotencyKey: `${runId}:write-1:1`,
    });
    controlPlane.claimNodeAttempt({
      id: attempt.id,
      workerId: 'dead-worker',
      leaseMs: 100,
    });
    const execute = vi.fn<WorkflowProviderExecutor['execute']>(async () => ({ text: 'unsafe' }));
    const recoveryRunner = runner({ controlPlane, workspace, root, execute });

    await recoveryRunner.execute(runId);

    expect(execute).not.toHaveBeenCalled();
    expect(controlPlane.getRunSnapshot(runId).run.status).toBe('failed');
    expect(controlPlane.ledger.getNodeAttempt(attempt.id)).toMatchObject({
      status: 'failed',
      error: 'Lease expired; manual retry required',
    });
    await recoveryRunner.close();
    controlPlane.close();
  });

  it('runs repository harness evidence against the canonical pinned workspace', async () => {
    const { root, workspace } = testWorkspace();
    const otherWorkspace = path.join(root, 'other-workspace');
    const alias = path.join(root, 'workspace-alias');
    fs.mkdirSync(otherWorkspace);
    fs.symlinkSync(workspace, alias, 'dir');
    const controlPlane = new LocalControlPlane(new SqliteRunLedger(path.join(root, 'harness.sqlite')));
    const profile = profiles.sol({ workspaceAccess: 'read-only' });
    const workflow = defineWorkflow({
      id: 'canonical-harness-workspace',
      name: 'Canonical harness workspace',
      metadata: { harness: 'repository' },
      steps: sequence(
        agent('review', profile, 'Review the canonical workspace.'),
        approval('accept', 'Accept the verified result.'),
      ),
    });
    const runId = publishRun(controlPlane, alias, workflow);
    let harnessWorkspace: string | undefined;
    const workflowRunner = new LocalWorkflowRunner({
      controlPlane,
      workspace: alias,
      artifactRoot: path.join(root, 'artifacts'),
      executor: { execute: async () => ({ text: 'reviewed' }) },
      runHarness: observed => {
        harnessWorkspace = observed;
        return runRepositoryHarness({
          workspace: observed,
          runCheck: async () => ({ status: 'passed', durationMs: 1 }),
        });
      },
    });
    fs.unlinkSync(alias);
    fs.symlinkSync(otherWorkspace, alias, 'dir');

    await workflowRunner.execute(runId);

    expect(harnessWorkspace).toBe(fs.realpathSync.native(workspace));
    expect(harnessWorkspace).not.toBe(fs.realpathSync.native(otherWorkspace));
    expect(controlPlane.getRunSnapshot(runId)).toMatchObject({
      run: { status: 'waiting' },
      approvals: [{ status: 'pending' }],
    });
    await workflowRunner.close();
    controlPlane.close();
  });
});
