import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createInMemoryRunLedger } from '../../src/persistence/runLedger.js';
import type { GoalSessionServiceOptions } from '../../src/workflows/goalSession.js';
import { GoalSessionService } from '../../src/workflows/goalSession.js';
import { projectGoalSessionUsage } from '../../src/workflows/goalSessionUsage.js';
import { ProviderExecutionError } from '../../src/workflows/providerUsage.js';

const nativeSessionId = '11111111-1111-4111-8111-111111111111';
const directories: string[] = [];
const ledgers: ReturnType<typeof createInMemoryRunLedger>[] = [];

const profile = {
  profileId: 'sol-director',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'max',
  workspaceAccess: 'workspace-write',
  selection: 'default',
  enableSubagents: false,
} as const;

function setup(execute: GoalSessionServiceOptions['executor']['execute']) {
  const store = createInMemoryRunLedger();
  ledgers.push(store);
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-goal-usage-'));
  directories.push(artifactRoot);
  const revision = store.recordWorkflowRevision({
    workflowId: 'goal-usage',
    definition: { nodes: [] },
  });
  const run = store.createRun({ workflowRevisionId: revision.id, workspace: process.cwd() });
  const service = new GoalSessionService({ store, artifactRoot, executor: { execute } });
  const session = service.openGoalSession({
    goal: 'Track every permanent-session provider call',
    profile,
    cwd: process.cwd(),
    runId: run.id,
  });
  return { run, service, session, store };
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('GoalSession provider usage', () => {
  it('persists reported fields on the reply without adding cache or reasoning twice', async () => {
    const { session } = setup(async () => ({
      text: 'done',
      sessionId: nativeSessionId,
      usage: {
        inputTokens: 120,
        cachedInputTokens: 90,
        outputTokens: 20,
        reasoningOutputTokens: 8,
      },
    }));

    const result = await session.turn('first call');
    const artifacts = session.inspect().artifacts;
    const projected = projectGoalSessionUsage(artifacts);

    expect(result.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 90,
      outputTokens: 20,
      reasoningOutputTokens: 8,
    });
    expect(artifacts.at(-1)).toMatchObject({
      kind: 'reply',
      metadata: {
        goalSessionTurn: { outcome: 'succeeded', resumed: false },
      },
    });
    expect(projected).toMatchObject({
      providerCalls: 1,
      usageReports: 1,
      totals: {
        inputTokens: 120,
        cachedInputTokens: 90,
        outputTokens: 20,
        reasoningOutputTokens: 8,
      },
    });
    expect(projected.totals.inputTokens).toBe(120);
  });

  it('keeps every absent provider field unknown instead of persisting zeroes', async () => {
    const { session } = setup(async () => ({ text: 'done', sessionId: nativeSessionId }));

    const result = await session.turn('unreported call');
    const projected = projectGoalSessionUsage(session.inspect().artifacts);

    expect(result.usage).toBeUndefined();
    expect(projected).toMatchObject({ providerCalls: 1, usageReports: 0, totals: {} });
    expect(projected.fieldReports.inputTokens).toBe(0);
    expect(projected.totals).not.toHaveProperty('estimatedCostUsd');
  });

  it('records usage and resume scope independently for every continued turn', async () => {
    let call = 0;
    const { session } = setup(async () => ({
      text: `reply-${++call}`,
      sessionId: nativeSessionId,
      usage: call === 1 ? { inputTokens: 100 } : { outputTokens: 25 },
    }));

    await session.turn('start');
    await session.turn('continue');
    const projected = projectGoalSessionUsage(session.inspect().artifacts);

    expect(projected.turns.map(turn => ({ resumed: turn.resumed, usage: turn.usage }))).toEqual([
      { resumed: false, usage: { inputTokens: 100 } },
      { resumed: true, usage: { outputTokens: 25 } },
    ]);
    expect(projected).toMatchObject({
      providerCalls: 2,
      usageReports: 2,
      totals: { inputTokens: 100, outputTokens: 25 },
    });
  });

  it('persists provider-failure usage without copying instruction text into run events', async () => {
    const { run, session, store } = setup(async () => {
      throw new ProviderExecutionError('provider failed', {
        sessionId: nativeSessionId,
        usage: { inputTokens: 44, cachedInputTokens: 40, outputTokens: 3 },
      });
    });

    await expect(session.turn('SECRET-FAILED-INSTRUCTION')).rejects.toThrow(/provider failed/);
    const artifacts = session.inspect().artifacts;
    const projected = projectGoalSessionUsage(artifacts);
    const serializedEvents = JSON.stringify(store.listEvents(run.id));

    expect(artifacts.map(artifact => artifact.kind)).toEqual(['goal', 'instruction', 'usage']);
    expect(projected.turns[0]).toMatchObject({
      outcome: 'failed',
      resumed: false,
      usage: { inputTokens: 44, cachedInputTokens: 40, outputTokens: 3 },
    });
    expect(projected.totals.inputTokens).toBe(44);
    expect(serializedEvents).not.toContain('SECRET-FAILED-INSTRUCTION');
    expect(serializedEvents).not.toContain('inputTokens');
    expect(session.inspect().session).toMatchObject({
      status: 'active', turnState: 'idle', turnCount: 0,
    });
  });
});
