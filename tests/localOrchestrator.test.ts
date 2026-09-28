import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalControlPlane } from '../src/controlPlane/controlPlane.js';
import {
  LocalOrchestrator,
  createLocalOrchestrator,
  type LocalOrchestratorRunner,
} from '../src/localOrchestrator.js';
import { createInMemoryRunLedger } from '../src/persistence/runLedger.js';
import { defineWorkflowRevision, type WorkflowRevision } from '../src/workflows/domain.js';
import { profiles } from '../src/workflows/dsl.js';
import type { ProviderExecutionRequest } from '../src/workflows/executor.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function simpleWorkflow(): WorkflowRevision {
  return defineWorkflowRevision({
    id: 'package-facade-test',
    revision: 1,
    name: 'Package facade test',
    profiles: [{
      id: 'sol',
      label: 'Sol',
      role: 'conductor',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      workspaceAccess: 'read-only',
      selection: 'default',
    }],
    nodes: [
      {
        id: 'solve',
        kind: 'agent',
        label: 'Solve',
        profileId: 'sol',
        prompt: 'Solve {{objective}}',
      },
      { id: 'done', kind: 'end', label: 'Done' },
    ],
    edges: [{ from: 'solve', to: 'done' }],
  });
}

function fakeRunner(): LocalOrchestratorRunner & {
  execute: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  recover: ReturnType<typeof vi.fn>;
  resolveGateApproval: ReturnType<typeof vi.fn>;
} {
  return {
    execute: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    close: vi.fn(async () => undefined),
    recover: vi.fn(async () => undefined),
    resolveGateApproval: vi.fn(async () => undefined),
  };
}

describe('LocalOrchestrator', () => {
  it('accepts definitions and recorded revisions without ambiguous existing-run ids', async () => {
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const runner = fakeRunner();
    const orchestrator = new LocalOrchestrator({ controlPlane, runner });
    const recorded = orchestrator.publish(simpleWorkflow());

    expect(orchestrator.publish(recorded)).toStrictEqual(recorded);
    expect(orchestrator.publish(recorded.id)).toStrictEqual(recorded);

    const started = orchestrator.start(recorded, { objective: 'first' });
    const continued = await orchestrator.run({ runId: started.run.id });
    const fresh = await orchestrator.run(recorded, { objective: 'second' });

    expect(continued.run.id).toBe(started.run.id);
    expect(fresh.run.id).not.toBe(started.run.id);
    expect(runner.execute.mock.calls.map(call => call[0])).toEqual([
      started.run.id,
      fresh.run.id,
    ]);
    expect(orchestrator.list()).toHaveLength(2);

    await orchestrator.close();
    expect(runner.close).toHaveBeenCalledOnce();
    // Injected dependencies remain caller-owned by default.
    expect(controlPlane.listRuns()).toHaveLength(2);
    controlPlane.close();
  });

  it('delegates run controls and binds approval to the exact action hash', async () => {
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const runner = fakeRunner();
    const orchestrator = new LocalOrchestrator({ controlPlane, runner });
    const first = orchestrator.start(simpleWorkflow());
    const second = orchestrator.start(simpleWorkflow());
    const third = orchestrator.start(simpleWorkflow());

    expect(orchestrator.pause(first.run.id).run.status).toBe('waiting');
    expect((await orchestrator.resume(first.run.id)).run.status).toBe('running');
    expect(orchestrator.cancel(second.run.id).run.status).toBe('cancelled');
    expect(runner.stop).toHaveBeenCalledWith(
      second.run.id,
      'Run cancelled through LocalOrchestrator',
    );

    const approval = controlPlane.requestApproval({
      runId: third.run.id,
      actionHash: 'sha256:exact-action',
      risk: 'workspace-write',
    });
    await expect(orchestrator.approve({
      approvalId: approval.id,
      actionHash: 'sha256:changed-action',
      decisionBy: 'test',
    })).rejects.toThrow(/action hash changed/);
    const approved = await orchestrator.approve({
      approvalId: approval.id,
      actionHash: approval.actionHash,
      decisionBy: 'test',
    });

    expect(approved.run.id).toBe(third.run.id);
    expect(runner.resolveGateApproval).toHaveBeenCalledWith(
      expect.objectContaining({ id: approval.id, status: 'approved' }),
    );
    controlPlane.close();
  });

  it('constructs a fully local runtime and owns its durable lifecycle', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-facade-'));
    temporaryDirectories.push(directory);
    const nativeSessionId = '44444444-4444-4444-8444-444444444444';
    const execute = vi.fn(async (request: ProviderExecutionRequest) => ({
      text: 'Verified local result',
      ...(request.session ? { sessionId: nativeSessionId } : {}),
    }));
    const orchestrator = createLocalOrchestrator({
      workspace: directory,
      storePath: path.join(directory, 'state', 'runs.sqlite'),
      artifactRoot: path.join(directory, 'state', 'artifacts'),
      executor: { execute },
    });

    const result = await orchestrator.run(simpleWorkflow(), {
      objective: 'exercise the package facade',
    });

    expect(result.run.status).toBe('completed');
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        mediaType: 'text/markdown',
        metadata: expect.objectContaining({ model: 'gpt-5.6-sol' }),
      }),
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(fs.existsSync(result.artifacts[0].location)).toBe(true);

    const director = orchestrator.openGoal({
      goal: 'Keep improving this workflow until its evidence is complete',
      profile: profiles.sol(),
    });
    await director.turn('Inspect the current state and choose the next checkpoint.');
    await director.turn('Re-evaluate after the checkpoint and continue.');

    expect(orchestrator.getGoal(director.id)?.inspect().session).toMatchObject({
      nativeSessionId,
      turnCount: 2,
      cwd: directory,
    });
    expect(orchestrator.listGoals()).toEqual([
      expect.objectContaining({ id: director.id, profileId: 'sol-conductor' }),
    ]);
    expect(execute.mock.calls[1][0].session).toEqual({ mode: 'start' });
    expect(execute.mock.calls[2][0].session).toEqual({
      mode: 'resume',
      sessionId: nativeSessionId,
    });

    await orchestrator.close();
    await orchestrator.close();
    expect(orchestrator.closed).toBe(true);
    expect(() => orchestrator.list()).toThrow(/closed/);
  });

  it('projects run-bound goal lifecycle events to live subscribers without bodies', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-goal-events-'));
    temporaryDirectories.push(directory);
    const nativeSessionId = '55555555-5555-4555-8555-555555555555';
    const orchestrator = createLocalOrchestrator({
      workspace: directory,
      executor: {
        execute: async () => ({ text: 'SECRET-REPLY', sessionId: nativeSessionId }),
      },
    });
    const started = orchestrator.start(simpleWorkflow(), { objective: 'stream goal events' });
    const events: unknown[] = [];
    const unsubscribe = orchestrator.subscribe(started.run.id, event => events.push(event));
    const director = orchestrator.openGoal({
      goal: 'SECRET-GOAL',
      profile: profiles.sol(),
      runId: started.run.id,
    });

    await director.turn('SECRET-INSTRUCTION');
    await director.close();

    expect(events).toEqual([
      expect.objectContaining({ type: 'goal.session.opened' }),
      expect.objectContaining({ type: 'goal.turn.started' }),
      expect.objectContaining({ type: 'goal.turn.completed' }),
      expect.objectContaining({ type: 'goal.session.closed' }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(/SECRET-(GOAL|INSTRUCTION|REPLY)/);

    unsubscribe();
    orchestrator.cancel(started.run.id);
    await orchestrator.close();
  });
});
