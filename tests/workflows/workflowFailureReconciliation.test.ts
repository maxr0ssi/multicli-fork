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

describe('parallel workflow failure reconciliation', () => {
  it('commits an admitted sibling before failing the run exactly once', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-parallel-failure-'));
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const reviewer = profiles.sol({ workspaceAccess: 'read-only' });
    const revision = defineWorkflow({
      id: 'parallel-failure',
      name: 'Parallel failure',
      steps: sequence(parallel('reviewers', [
        agent('fails', reviewer, 'Fail this review.'),
        agent('finishes', reviewer, 'Finish this review.'),
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
    let providerCall = 0;
    const execute = vi.fn<WorkflowProviderExecutor['execute']>(async () => {
      providerCall += 1;
      if (providerCall === 1) throw new Error('provider failed');
      await new Promise(resolve => setTimeout(resolve, 10));
      return { text: 'sibling result' };
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
      expect(snapshot.events.filter(event => event.type === 'node.failed')).toHaveLength(1);
      expect(snapshot.events.filter(event => event.type === 'node.succeeded')).toHaveLength(1);
      expect(snapshot.events.filter(event => event.type === 'run.failed')).toHaveLength(1);
      expect(snapshot.run.status).toBe('failed');
      expect(semantic.status).toBe('failed');

      await runner.execute(runId);
      expect(controlPlane.getRunSnapshot(runId).events.filter(
        event => event.type === 'run.failed',
      )).toHaveLength(1);
    } finally {
      await runner.close();
      controlPlane.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
