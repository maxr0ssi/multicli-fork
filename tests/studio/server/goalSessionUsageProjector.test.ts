import fs from 'node:fs';
import os from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalControlPlane } from '../../../src/controlPlane/controlPlane.js';
import { createInMemoryRunLedger } from '../../../src/persistence/runLedger.js';
import { StudioQueryService } from '../../../src/studio/server/studioQueryService.js';
import { agent, defineWorkflow, profiles, sequence } from '../../../src/workflows/dsl.js';
import { goalSessionTurnMetadata } from '../../../src/workflows/goalSessionUsage.js';

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

describe('Studio permanent-session usage projection', () => {
  it('keeps permanent-turn usage scoped apart from workflow attempts with field coverage', () => {
    const workspace = fs.mkdtempSync(`${os.tmpdir()}/multicli-goal-studio-`);
    workspaces.push(workspace);
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const definition = defineWorkflow({
      id: 'goal-studio-usage',
      revision: 1,
      name: 'Goal usage',
      steps: sequence(agent('direct', profiles.sol({ id: 'sol' }), 'Direct.')),
    });
    const revision = controlPlane.publishWorkflow({
      workflowId: definition.id,
      definition,
    });
    const run = controlPlane.startRun({
      workflowRevisionId: revision.id,
      workspace,
      runInput: { objective: 'Project permanent usage' },
    }).run;
    const session = controlPlane.ledger.createGoalSession({
      runId: run.id,
      profileId: 'sol',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      workspaceAccess: 'workspace-write',
      selection: 'default',
      enableSubagents: false,
      cwd: workspace,
      goalArtifact: {
        contentHash: 'goal', mediaType: 'text/markdown', name: 'Goal',
        location: `${workspace}/goal.md`, metadata: { private: true },
      },
    });
    const firstOwner = 'first-owner';
    controlPlane.ledger.claimGoalSessionTurn({
      id: session.id, owner: firstOwner, leaseMs: 60_000,
    });
    const instruction = controlPlane.ledger.recordGoalSessionArtifact({
      sessionId: session.id, turnNumber: 1, kind: 'instruction', contentHash: 'instruction',
      mediaType: 'text/markdown', name: 'Instruction', location: `${workspace}/instruction.md`,
      metadata: { private: true },
    });
    const reply = controlPlane.ledger.recordGoalSessionArtifact({
      sessionId: session.id, turnNumber: 1, kind: 'reply', contentHash: 'reply',
      mediaType: 'text/markdown', name: 'Reply', location: `${workspace}/reply.md`,
      metadata: goalSessionTurnMetadata({
        outcome: 'succeeded', resumed: false,
        usage: { inputTokens: 100, cachedInputTokens: 80 },
      }),
    });
    controlPlane.ledger.completeGoalSessionTurn({
      id: session.id,
      owner: firstOwner,
      nativeSessionId: '11111111-1111-4111-8111-111111111111',
      instructionArtifactId: instruction.id,
      replyArtifactId: reply.id,
    });
    const secondOwner = 'second-owner';
    controlPlane.ledger.claimGoalSessionTurn({
      id: session.id, owner: secondOwner, leaseMs: 60_000,
    });
    controlPlane.ledger.recordGoalSessionArtifact({
      sessionId: session.id, turnNumber: 2, kind: 'usage', contentHash: 'failed-usage',
      mediaType: 'application/vnd.multicli.goal-turn+json', name: 'Failed call usage',
      location: `${workspace}/failed-usage.json`,
      metadata: goalSessionTurnMetadata({
        outcome: 'failed', resumed: true, usage: { outputTokens: 20 },
      }),
    });
    controlPlane.ledger.failGoalSessionTurn({
      id: session.id, owner: secondOwner, reason: 'provider_execution_failed',
    });

    const view = new StudioQueryService({
      controlPlane, workspace, goalSessionsEnabled: true,
    }).getRunView(run.id);

    expect(view.goalSessions[0].providerUsage).toEqual({
      scope: 'permanent-goal-session',
      providerCalls: 2,
      usageReports: 2,
      totals: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 },
      fieldReports: {
        estimatedCostUsd: 0,
        inputTokens: 1,
        cachedInputTokens: 1,
        cacheCreationInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
      turns: [
        expect.objectContaining({ outcome: 'succeeded', resumed: false }),
        expect.objectContaining({ outcome: 'failed', resumed: true }),
      ],
    });
    expect(view.execution.budget.usage).toMatchObject({
      modelCalls: 0, nodeAttempts: 0, usageReports: 0,
    });
    controlPlane.close();
  });
});
