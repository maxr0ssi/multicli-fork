import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { LocalControlPlane } from '../../src/controlPlane/controlPlane.js';
import { createInMemoryRunLedger } from '../../src/persistence/runLedger.js';
import { agent, defineWorkflow, parallel, profiles, sequence } from '../../src/workflows/dsl.js';
import type { WorkflowProviderExecutor } from '../../src/workflows/executor.js';
import { projectWorkflowRun } from '../../src/workflows/runProjection.js';
import { LocalWorkflowRunner } from '../../src/workflows/runner.js';

describe('workflow provider budget admission', () => {
  it('blocks the next call before spending a one-call budget', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-runner-budget-'));
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const reviewer = profiles.sol({ workspaceAccess: 'read-only' });
    const revision = defineWorkflow({
      id: 'admission-budget',
      name: 'Admission budget',
      budget: { maxModelCalls: 1 },
      steps: sequence(
        agent('first', reviewer, 'Review first.'),
        agent('second', reviewer, 'Review second.'),
      ),
    });
    const durable = controlPlane.publishWorkflow({
      workflowId: revision.id,
      definition: revision,
    });
    const runId = controlPlane.startRun({
      workflowRevisionId: durable.id,
      workspace,
    }).run.id;
    const execute = vi.fn<WorkflowProviderExecutor['execute']>(
      async () => ({ text: 'reviewed' }),
    );
    const runner = new LocalWorkflowRunner({
      controlPlane,
      executor: { execute },
      workspace,
      artifactRoot: path.join(workspace, 'artifacts'),
    });

    try {
      await runner.execute(runId);
      const snapshot = controlPlane.getRunSnapshot(runId);
      const semantic = projectWorkflowRun({
        revision,
        runId,
        createdAt: snapshot.run.createdAt,
        events: snapshot.events,
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(snapshot.run.status).toBe('failed');
      expect(snapshot.events.filter(event => event.type === 'node.started')).toHaveLength(1);
      expect(snapshot.events.filter(
        event => event.type === 'run.budget_exhausted',
      )).toHaveLength(1);
      expect(semantic.status).toBe('budget_exhausted');
      expect(semantic.budget.usage.modelCalls).toBe(1);

      await runner.execute(runId);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await runner.close();
      controlPlane.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reconciles parallel completions before durably exhausting a reported-usage budget', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-parallel-budget-'));
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const reviewer = profiles.sol({ workspaceAccess: 'read-only' });
    const revision = defineWorkflow({
      id: 'parallel-usage-budget',
      name: 'Parallel usage budget',
      budget: { maxInputTokens: 1 },
      steps: sequence(parallel('reviewers', [
        agent('first', reviewer, 'Review first.'),
        agent('second', reviewer, 'Review second.'),
      ])),
    });
    const durable = controlPlane.publishWorkflow({
      workflowId: revision.id,
      definition: revision,
    });
    const runId = controlPlane.startRun({
      workflowRevisionId: durable.id,
      workspace,
    }).run.id;
    const execute = vi.fn<WorkflowProviderExecutor['execute']>(async request => {
      if (request.prompt.includes('Node: Second')) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return { text: 'reviewed', usage: { inputTokens: 2 } };
    });
    const runner = new LocalWorkflowRunner({
      controlPlane,
      executor: { execute },
      workspace,
      artifactRoot: path.join(workspace, 'artifacts'),
    });

    try {
      await expect(runner.execute(runId)).resolves.toBeUndefined();
      const snapshot = controlPlane.getRunSnapshot(runId);
      const semantic = projectWorkflowRun({
        revision,
        runId,
        createdAt: snapshot.run.createdAt,
        events: snapshot.events,
      });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(snapshot.events.filter(event => event.type === 'node.succeeded')).toHaveLength(2);
      expect(snapshot.events.filter(
        event => event.type === 'run.budget_exhausted',
      )).toHaveLength(1);
      expect(snapshot.run.status).toBe('failed');
      expect(semantic.status).toBe('budget_exhausted');
      expect(semantic.budget.usage).toMatchObject({ modelCalls: 2, inputTokens: 4 });

      await runner.execute(runId);
      expect(controlPlane.getRunSnapshot(runId).events.filter(
        event => event.type === 'run.budget_exhausted',
      )).toHaveLength(1);
    } finally {
      await runner.close();
      controlPlane.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
