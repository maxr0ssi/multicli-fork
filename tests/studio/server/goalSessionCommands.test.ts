import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalControlPlane } from '../../../src/controlPlane/controlPlane.js';
import type { Logger } from '../../../src/logger.js';
import { createInMemoryRunLedger } from '../../../src/persistence/runLedger.js';
import { StudioGoalSessionCommands } from '../../../src/studio/server/goalSessionCommands.js';
import type { ProviderExecutionResult } from '../../../src/workflows/executor.js';
import { GoalSessionService } from '../../../src/workflows/goalSession.js';
import {
  LUNA_MAX_BUILDER_PROFILE,
  createLunaBuildCouncilDefinition,
} from '../../../src/workflows/lunaBuildCouncil.js';

const controls: LocalControlPlane[] = [];
const temporaryDirectories: string[] = [];

function logger(): Logger {
  const value: Logger = {
    logPath: ':memory:',
    sessionId: 'goal-command-test',
    child: () => value,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function setup(execute: () => Promise<ProviderExecutionResult>) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-goal-command-'));
  temporaryDirectories.push(workspace);
  const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
  controls.push(controlPlane);
  const revision = controlPlane.publishWorkflow({
    workflowId: 'goal-command-workflow',
    definition: {
      ...createLunaBuildCouncilDefinition({ builderCount: 2 }),
      id: 'goal-command-workflow',
    },
  });
  const run = controlPlane.startRun({ workflowRevisionId: revision.id, workspace }).run;
  const sessions = new GoalSessionService({
    store: controlPlane.ledger,
    executor: { execute },
    artifactRoot: path.join(workspace, 'artifacts'),
  });
  const commands = new StudioGoalSessionCommands({
    controlPlane,
    sessions,
    workspace,
    logger: logger(),
  });
  return { commands, controlPlane, revision, run, sessions, workspace };
}

afterEach(() => {
  for (const control of controls.splice(0)) control.close();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('StudioGoalSessionCommands', () => {
  it('pins a profile from the immutable run revision and hides local paths', async () => {
    const { commands, controlPlane, run, workspace } = setup(async () => ({
      text: 'unused',
      sessionId: '11111111-1111-4111-8111-111111111111',
    }));
    const opened = commands.open({
      runId: run.id,
      profileId: LUNA_MAX_BUILDER_PROFILE.id,
      goal: 'Direct this implementation across several iterations.',
    });

    expect(opened).toMatchObject({
      runId: run.id,
      profileId: LUNA_MAX_BUILDER_PROFILE.id,
      model: LUNA_MAX_BUILDER_PROFILE.model,
      status: 'active',
    });
    expect(opened).not.toHaveProperty('cwd');
    expect(controlPlane.ledger.getGoalSession(opened.id)?.cwd)
      .toBe(fs.realpathSync.native(workspace));
    expect(() => commands.open({
      runId: run.id,
      profileId: 'not-in-this-revision',
      goal: 'No profile substitution.',
    })).toThrow('Unknown workflow profile');
    await expect(commands.close(opened.id)).resolves.toMatchObject({
      id: opened.id,
      status: 'closed',
    });
  });

  it('accepts one silent turn immediately and never creates a volatile queue', async () => {
    const provider = deferred<ProviderExecutionResult>();
    const { commands, controlPlane, run } = setup(() => provider.promise);
    const opened = commands.open({
      runId: run.id,
      profileId: LUNA_MAX_BUILDER_PROFILE.id,
      goal: 'Keep continuity while the model thinks.',
    });

    expect(commands.instruct(opened.id, 'Begin the first bounded iteration.')).toEqual({
      accepted: true,
      sessionId: opened.id,
    });
    expect(() => commands.instruct(opened.id, 'Do not queue this in memory.'))
      .toThrow('already has a turn in flight');
    provider.resolve({
      text: 'Completed after a long silent interval.',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    await commands.shutdown();
    expect(controlPlane.ledger.getGoalSession(opened.id)).toMatchObject({
      turnCount: 1,
      turnState: 'idle',
      status: 'active',
    });
  });

  it('continues from a terminal run without mutating its frozen event history', async () => {
    const { commands, controlPlane, run } = setup(async () => ({
      text: 'A new durable continuation, separate from the failed run.',
      sessionId: '11111111-1111-4111-8111-111111111111',
    }));
    controlPlane.appendEvent(run.id, 'run.failed', { reason: 'Original attempt failed' });
    const terminal = controlPlane.ledger.getRun(run.id)!;
    const opened = commands.open({
      runId: run.id,
      profileId: LUNA_MAX_BUILDER_PROFILE.id,
      goal: 'Recover the useful work without rewriting the terminal run.',
    });

    expect(commands.instruct(opened.id, 'Continue from the preserved evidence.')).toEqual({
      accepted: true,
      sessionId: opened.id,
    });
    await commands.shutdown();

    expect(controlPlane.ledger.getGoalSession(opened.id)).toMatchObject({
      runId: run.id,
      status: 'active',
      turnState: 'idle',
      turnCount: 1,
    });
    expect(controlPlane.ledger.getRun(run.id)).toEqual(terminal);
    expect(controlPlane.ledger.listEvents(run.id).at(-1)?.type).toBe('run.failed');
  });

  it('rejects foreign run and session commands before provider work or mutation', async () => {
    const execute = vi.fn(async () => ({
      text: 'must not execute',
      sessionId: '11111111-1111-4111-8111-111111111111',
    }));
    const { commands, controlPlane, revision, sessions } = setup(execute);
    const foreignWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-foreign-goal-'));
    temporaryDirectories.push(foreignWorkspace);
    const foreignRun = controlPlane.startRun({
      workflowRevisionId: revision.id,
      workspace: foreignWorkspace,
    }).run;

    expect(() => commands.open({
      runId: foreignRun.id,
      profileId: LUNA_MAX_BUILDER_PROFILE.id,
      goal: 'Do not cross workspace authority.',
    })).toThrow(/Studio server is pinned/);
    const foreignSession = sessions.openGoalSession({
      goal: 'Remain pinned to the foreign workspace.',
      profile: LUNA_MAX_BUILDER_PROFILE,
      cwd: foreignWorkspace,
      runId: foreignRun.id,
      workflowRevisionId: revision.id,
    }).inspect().session;

    expect(() => commands.instruct(foreignSession.id, 'Do not execute.'))
      .toThrow(/Studio server is pinned/);
    await expect(commands.close(foreignSession.id)).rejects.toThrow(/Studio server is pinned/);
    expect(execute).not.toHaveBeenCalled();
    expect(controlPlane.ledger.getGoalSession(foreignSession.id)).toMatchObject({
      status: 'active',
      turnState: 'idle',
    });
  });
});
