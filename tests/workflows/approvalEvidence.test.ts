import { describe, expect, it } from 'vitest';

import { createWorkflowGateApproval } from '../../src/workflows/approvalEvidence.js';

describe('workflow gate approval evidence', () => {
  it('binds artifact and harness evidence without exposing file locations', () => {
    const result = createWorkflowGateApproval({
      run: { id: 'run-1' },
      workflowRevision: {
        id: 'revision-1',
        workflowId: 'workflow-1',
        contentHash: 'workflow-hash',
      },
      artifacts: [{
        id: 'artifact-1',
        contentHash: 'artifact-hash',
        mediaType: 'text/markdown',
        location: '/private/result.md',
      }],
      events: [{
        runId: 'run-1',
        sequence: 8,
        timestamp: '2026-08-09T00:00:00.000Z',
        type: 'harness.completed',
        payload: {
          gateId: 'review',
          invocationId: 'harness-1',
          outcome: 'pass',
          findingCount: 0,
          checks: [{ ruleId: 'tests', label: 'Tests', status: 'pass', durationMs: 12 }],
        },
      }],
    } as any, {
      id: 'review',
      label: 'Review',
      kind: 'gate',
      gate: 'manual',
      prompt: 'Approve the evidence.',
    });

    expect(result.actionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.payload).toMatchObject({
      nodeId: 'review',
      artifacts: [{ id: 'artifact-1', contentHash: 'artifact-hash' }],
      harness: { invocationId: 'harness-1' },
    });
    expect(JSON.stringify(result.payload)).not.toContain('/private/result.md');
  });
});
