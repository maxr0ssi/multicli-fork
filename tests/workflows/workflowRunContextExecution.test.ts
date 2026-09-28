import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { LocalControlPlane } from '../../src/controlPlane/controlPlane.js';
import { createInMemoryRunLedger } from '../../src/persistence/runLedger.js';
import { agent, defineWorkflow, profiles, sequence } from '../../src/workflows/dsl.js';
import type { WorkflowProviderExecutor } from '../../src/workflows/executor.js';
import { renderWorkflowRunContext } from '../../src/workflows/runContext.js';
import { LocalWorkflowRunner } from '../../src/workflows/runner.js';

describe('workflow provider run context', () => {
  it('sends every proposed run-input field to every provider node', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-run-context-'));
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const revision = defineWorkflow({
      id: 'full-run-context',
      name: 'Full run context',
      steps: sequence(
        agent('plan', profiles.sol(), 'Plan {{objective}}.'),
        agent('review', profiles.opus(), 'Review {{objective}}.'),
      ),
    });
    const durable = controlPlane.publishWorkflow({
      workflowId: revision.id,
      definition: revision,
    });
    const runInput = {
      objective: 'Ship the editor',
      acceptanceCriteria: ['All controls are real'],
      constraints: ['Local subscription CLIs only'],
      context: { repository: 'multicli' },
      riskTolerance: 'low',
    };
    const runId = controlPlane.startRun({
      workflowRevisionId: durable.id,
      workspace,
      runInput,
    }).run.id;
    const execute = vi.fn<WorkflowProviderExecutor['execute']>(
      async () => ({ text: 'done' }),
    );
    const runner = new LocalWorkflowRunner({
      controlPlane,
      executor: { execute },
      workspace,
      artifactRoot: path.join(workspace, 'artifacts'),
    });

    try {
      await runner.execute(runId);
      const exactContext = renderWorkflowRunContext(runInput);
      expect(execute).toHaveBeenCalledTimes(2);
      for (const [request] of execute.mock.calls) {
        expect(request.prompt).toContain('Ship the editor');
        expect(request.prompt).toContain(
          `Run input (exact operator-supplied JSON):\n${exactContext}`,
        );
      }
    } finally {
      await runner.close();
      controlPlane.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
