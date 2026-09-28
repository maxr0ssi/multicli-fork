import { describe, expect, it } from 'vitest';

import { createInMemoryRunLedger } from '../../src/persistence/runLedger.js';
import { createLunaBuildCouncilDefinition } from '../../src/workflows/lunaBuildCouncil.js';

describe('approval history', () => {
  it('retains resolved decisions while pending queries remain focused', () => {
    const ledger = createInMemoryRunLedger();
    const revision = ledger.recordWorkflowRevision({
      workflowId: 'approval-history',
      definition: createLunaBuildCouncilDefinition({ builderCount: 2 }),
    });
    const run = ledger.createStartedRun({
      workflowRevisionId: revision.id, workspace: process.cwd(),
    }).run;
    const first = ledger.requestApproval({
      runId: run.id,
      risk: 'workflow-completion',
      actionHash: 'first-action',
    });
    const second = ledger.requestApproval({
      runId: run.id,
      risk: 'write',
      actionHash: 'second-action',
    });
    ledger.resolveApproval({
      id: first.id,
      decision: 'approved',
      decisionBy: 'local-studio',
      actionHash: first.actionHash,
    });

    expect(ledger.listPendingApprovals(run.id).map(item => item.id)).toEqual([second.id]);
    expect(ledger.listApprovals(run.id)).toEqual(expect.arrayContaining([
      { id: first.id, status: 'approved', decisionBy: 'local-studio' },
      { id: second.id, status: 'pending' },
    ].map(expected => expect.objectContaining(expected))));
    ledger.close();
  });
});
