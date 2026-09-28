import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SqliteRunLedger,
  createInMemoryRunLedger,
} from '../../src/persistence/runLedger.js';
import type { ProviderExecutionRequest } from '../../src/workflows/executor.js';
import {
  GoalSessionService,
  type GoalSessionServiceOptions,
} from '../../src/workflows/goalSession.js';
import { projectGoalSessionUsage } from '../../src/workflows/goalSessionUsage.js';

const nativeSessionId = '11111111-1111-4111-8111-111111111111';
const alternativeNativeSessionId = '22222222-2222-4222-8222-222222222222';
const temporaryDirectories: string[] = [];
const ledgers: ReturnType<typeof createInMemoryRunLedger>[] = [];

function setup(execute: GoalSessionServiceOptions['executor']['execute']) {
  const store = createInMemoryRunLedger();
  ledgers.push(store);
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-goal-session-'));
  temporaryDirectories.push(artifactRoot);
  const revision = store.recordWorkflowRevision({
    workflowId: 'permanent-sol-director',
    definition: { nodes: [] },
  });
  const run = store.createRun({ workflowRevisionId: revision.id, workspace: process.cwd() });
  const service = new GoalSessionService({
    store,
    artifactRoot,
    executor: { execute },
  });
  return { store, artifactRoot, revision, run, service };
}

const solProfile = {
  profileId: 'sol-director',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'max',
  workspaceAccess: 'workspace-write',
  selection: 'default',
  enableSubagents: false,
} as const;

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('GoalSessionService', () => {
  it('renews a silent permanent-session turn through the provider heartbeat', async () => {
    let heartbeat: (() => void) | undefined;
    const { service, store } = setup(async request => {
      heartbeat = request.onHeartbeat;
      heartbeat?.();
      return { text: 'long review completed', sessionId: nativeSessionId };
    });
    const renew = vi.spyOn(store, 'renewGoalSessionTurnLease');
    const session = service.openGoalSession({
      goal: 'Review patiently',
      profile: solProfile,
      cwd: process.cwd(),
    });

    await expect(session.turn('Take the time required.')).resolves.toMatchObject({
      text: 'long review completed',
    });
    expect(heartbeat).toBeTypeOf('function');
    expect(renew).toHaveBeenCalledOnce();
  });

  it('pins and resumes one provider-native session while exposing fresh run metadata', async () => {
    const requests: ProviderExecutionRequest[] = [];
    const { service, store, run, artifactRoot } = setup(async request => {
      requests.push(request);
      return { text: `reply-${requests.length}`, sessionId: nativeSessionId };
    });
    const session = service.openGoalSession({
      goal: 'Ship the permanent workflow director',
      profile: solProfile,
      cwd: process.cwd(),
      runId: run.id,
    });

    const first = await session.turn('Plan the topology');
    store.appendEvent(run.id, 'run.started');
    const reopened = new GoalSessionService({
      store,
      artifactRoot,
      executor: {
        execute: async request => {
          requests.push(request);
          return { text: 'reply-2', sessionId: nativeSessionId };
        },
      },
    }).get(session.id)!;
    const second = await reopened.turn('Inspect progress and choose the next step');

    expect(requests[0]).toMatchObject({
      cwd: process.cwd(),
      profile: solProfile,
      session: { mode: 'start' },
    });
    expect(requests[0].prompt).toContain('Ship the permanent workflow director');
    expect(requests[0].prompt).toContain(`runId=${run.id}`);
    expect(requests[1]).toMatchObject({
      cwd: process.cwd(),
      profile: solProfile,
      session: { mode: 'resume', sessionId: nativeSessionId },
    });
    expect(requests[1].prompt).toContain('run.started');
    expect(first.session.turnCount).toBe(1);
    expect(second.session).toMatchObject({
      nativeSessionId,
      turnCount: 2,
      turnState: 'idle',
      runId: run.id,
      workflowRevisionId: run.workflowRevisionId,
    });
  });

  it('serializes simultaneous turns and preserves turn order', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const requests: ProviderExecutionRequest[] = [];
    const { service } = setup(async request => {
      requests.push(request);
      if (requests.length === 1) await firstGate;
      return { text: `reply-${requests.length}`, sessionId: nativeSessionId };
    });
    const session = service.openGoalSession({
      goal: 'Iterate safely',
      profile: solProfile,
      cwd: process.cwd(),
    });

    const first = session.turn('first');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const second = session.turn('second');
    await new Promise(resolve => setImmediate(resolve));
    expect(requests).toHaveLength(1);

    releaseFirst();
    await expect(first).resolves.toMatchObject({ text: 'reply-1' });
    await expect(second).resolves.toMatchObject({ text: 'reply-2' });
    expect(requests[1].session).toEqual({ mode: 'resume', sessionId: nativeSessionId });
    expect(session.inspect().session.turnCount).toBe(2);
  });

  it('keeps goal, instruction, and reply bodies out of run events', async () => {
    const goal = 'SECRET-GOAL-BODY';
    const instruction = 'SECRET-INSTRUCTION-BODY';
    const reply = 'SECRET-REPLY-BODY';
    const { service, store, run } = setup(async () => ({
      text: reply,
      sessionId: nativeSessionId,
    }));
    const session = service.openGoalSession({
      goal,
      profile: solProfile,
      cwd: process.cwd(),
      runId: run.id,
    });

    await session.turn(instruction);
    const inspection = session.inspect();
    const serializedEvents = JSON.stringify(store.listEvents(run.id));

    expect(serializedEvents).not.toContain(goal);
    expect(serializedEvents).not.toContain(instruction);
    expect(serializedEvents).not.toContain(reply);
    expect(inspection.artifacts.map(artifact => artifact.kind)).toEqual([
      'goal',
      'instruction',
      'reply',
    ]);
    expect(fs.readFileSync(inspection.artifacts[0].location, 'utf8')).toBe(goal);
    expect(fs.readFileSync(inspection.artifacts[1].location, 'utf8')).toBe(instruction);
    expect(fs.readFileSync(inspection.artifacts[2].location, 'utf8')).toBe(reply);
    for (const artifact of inspection.artifacts) {
      expect(fs.statSync(artifact.location).mode & 0o077).toBe(0);
    }
    expect(store.listEvents(run.id).map(event => event.type)).toEqual([
      'goal.session.opened',
      'goal.turn.started',
      'goal.turn.completed',
    ]);
  });

  it('fails closed if the provider returns a different native session id', async () => {
    let call = 0;
    const { service, store, run } = setup(async () => ({
      text: `reply-${++call}`,
      sessionId: call === 1 ? nativeSessionId : alternativeNativeSessionId,
    }));
    const session = service.openGoalSession({
      goal: 'Never replace the native pin',
      profile: solProfile,
      cwd: process.cwd(),
      runId: run.id,
    });
    await session.turn('start');

    await expect(session.turn('resume')).rejects.toThrow(/different native session id/);
    expect(session.inspect().session).toMatchObject({
      nativeSessionId,
      turnCount: 1,
      turnState: 'idle',
      status: 'blocked',
    });
    expect(store.listEvents(run.id).at(-1)).toMatchObject({
      type: 'goal.session.blocked',
      payload: { reason: 'native_session_changed' },
    });
    await expect(session.turn('do not replace it')).rejects.toThrow(/blocked/);
  });

  it('accepts a workflow profile and cannot overwrite a duplicate custom session id', () => {
    const { service } = setup(async () => ({ text: 'unused', sessionId: nativeSessionId }));
    const id = '33333333-3333-4333-8333-333333333333';
    const workflowProfile = {
      id: 'sol-workflow-profile',
      label: 'Sol director',
      role: 'conductor',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      workspaceAccess: 'workspace-write',
      selection: 'default',
    } as const;
    const session = service.openGoalSession({
      id,
      goal: 'ORIGINAL-GOAL',
      profile: workflowProfile,
      cwd: process.cwd(),
    });
    const goalArtifact = session.inspect().artifacts[0];

    expect(() => service.openGoalSession({
      id,
      goal: 'OVERWRITE-ATTEMPT',
      profile: workflowProfile,
      cwd: process.cwd(),
    })).toThrow(/already exists/);
    expect(fs.readFileSync(goalArtifact.location, 'utf8')).toBe('ORIGINAL-GOAL');
    expect(session.inspect().session).toMatchObject({
      profileId: workflowProfile.id,
      model: workflowProfile.model,
    });
    expect(() => service.openGoalSession({
      id: '------------------------------------',
      goal: 'invalid id',
      profile: workflowProfile,
      cwd: process.cwd(),
    })).toThrow(/must be a UUID/);
  });

  it('blocks instead of replaying when persistence fails after the provider advanced', async () => {
    const { service, store, run } = setup(async () => ({
      text: 'provider already advanced',
      sessionId: nativeSessionId,
    }));
    const original = store.recordGoalSessionArtifact.bind(store);
    vi.spyOn(store, 'recordGoalSessionArtifact').mockImplementation(input => {
      if (input.kind === 'reply' || input.kind === 'usage') {
        throw new Error('simulated disk ledger failure');
      }
      return original(input);
    });
    const session = service.openGoalSession({
      goal: 'Never replay an advanced turn',
      profile: solProfile,
      cwd: process.cwd(),
      runId: run.id,
    });

    await expect(session.turn('advance once')).rejects.toThrow(/simulated disk ledger failure/);
    expect(session.inspect().session).toMatchObject({
      status: 'blocked',
      turnCount: 0,
      nativeSessionId,
    });
    expect(store.listEvents(run.id).at(-1)).toMatchObject({
      type: 'goal.session.blocked',
      payload: { reason: 'post_provider_persistence_failed' },
    });
    await expect(session.turn('would replay')).rejects.toThrow(/blocked/);
  });

  it('lists, inspects, and closes standalone sessions without a run', async () => {
    const requests: ProviderExecutionRequest[] = [];
    const { service, revision, run, store } = setup(async request => {
      requests.push(request);
      return { text: 'done', sessionId: nativeSessionId };
    });
    const session = service.openGoalSession({
      goal: 'Standalone planning',
      profile: solProfile,
      cwd: process.cwd(),
      workflowRevisionId: revision.id,
    });
    store.appendEvent(run.id, 'run.started');
    await session.turn('Inspect every run of this pinned workflow.');

    expect(service.list()).toEqual([expect.objectContaining({ id: session.id })]);
    expect(service.list()[0].runId).toBeUndefined();
    expect(service.inspect(session.id).session.workflowRevisionId).toBe(revision.id);
    expect(requests[0].prompt).toContain(`workflowRevisionId=${revision.id}`);
    expect(requests[0].prompt).toContain(`runId=${run.id}`);
    expect(requests[0].prompt).toContain('run.started');
    await expect(session.close()).resolves.toMatchObject({ status: 'closed', turnCount: 1 });
    await expect(session.turn('too late')).rejects.toThrow(/closed/);
  });

  it('resumes the exact native session after reopening the SQLite ledger', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-goal-reopen-'));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, 'runs.sqlite');
    const firstStore = new SqliteRunLedger(databasePath);
    const firstService = new GoalSessionService({
      store: firstStore,
      artifactRoot: root,
      executor: {
        execute: async () => ({
          text: 'first', sessionId: nativeSessionId, usage: { inputTokens: 20 },
        }),
      },
    });
    const delegatedProfile = { ...solProfile, enableSubagents: true } as const;
    const session = firstService.openGoalSession({
      goal: 'Survive a process restart',
      profile: delegatedProfile,
      cwd: process.cwd(),
    });
    await session.turn('first turn');
    firstStore.close();

    const requests: ProviderExecutionRequest[] = [];
    const secondStore = new SqliteRunLedger(databasePath);
    ledgers.push(secondStore);
    const secondService = new GoalSessionService({
      store: secondStore,
      artifactRoot: root,
      executor: {
        execute: async request => {
          requests.push(request);
          return {
            text: 'second', sessionId: nativeSessionId, usage: { outputTokens: 5 },
          };
        },
      },
    });
    await secondService.get(session.id)!.turn('second turn');

    expect(requests[0].session).toEqual({ mode: 'resume', sessionId: nativeSessionId });
    expect(requests[0].profile.enableSubagents).toBe(true);
    expect(secondService.inspect(session.id).session.enableSubagents).toBe(true);
    expect(secondService.inspect(session.id).session.turnCount).toBe(2);
    expect(projectGoalSessionUsage(secondService.inspect(session.id).artifacts)).toMatchObject({
      providerCalls: 2,
      usageReports: 2,
      totals: { inputTokens: 20, outputTokens: 5 },
    });
  });
});
