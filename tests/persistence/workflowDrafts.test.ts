import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalControlPlane } from '../../src/controlPlane/controlPlane.js';
import {
  SqliteRunLedger,
  WorkflowDraftValidationError,
  createInMemoryRunLedger,
} from '../../src/persistence/runLedger.js';
import type { WorkflowRevision } from '../../src/workflows/domain.js';

const ledgers: SqliteRunLedger[] = [];
const directories: string[] = [];

function workflow(revision = 1): WorkflowRevision {
  return {
    id: 'draft-workflow',
    revision,
    name: 'Draft workflow',
    profiles: [{
      id: 'luna', label: 'Luna', role: 'builder', provider: 'codex',
      model: 'gpt-5.6-luna', reasoningEffort: 'max', workspaceAccess: 'workspace-write',
      selection: 'default', enableSubagents: false,
    }],
    nodes: [
      { id: 'build', label: 'Build', kind: 'agent', profileId: 'luna', prompt: 'Build it.' },
      { id: 'done', label: 'Done', kind: 'end' },
    ],
    edges: [{ from: 'build', to: 'done' }],
  };
}

function memoryLedger(): SqliteRunLedger {
  const ledger = createInMemoryRunLedger();
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable workflow drafts', () => {
  it('persists editable definitions and proposed run input across restarts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-drafts-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'runs.sqlite');
    const first = new SqliteRunLedger(databasePath);
    const created = first.createWorkflowDraft({
      id: 'persistent-draft', workflowId: 'draft-workflow', definition: workflow(),
      proposedRunInput: { objective: 'Sculpt the orchestration UI' },
    });
    first.close();

    const second = new SqliteRunLedger(databasePath);
    ledgers.push(second);
    expect(second.getWorkflowDraft(created.id)).toMatchObject({
      id: 'persistent-draft',
      version: 1,
      proposedRunInput: { objective: 'Sculpt the orchestration UI' },
    });
  });

  it('saves semantically invalid graphs but rejects stale writers', () => {
    const ledger = memoryLedger();
    const created = ledger.createWorkflowDraft({
      id: 'editable-draft', workflowId: 'draft-workflow', definition: workflow(),
    });
    const invalid = { ...workflow(), edges: [] };
    const updated = ledger.updateWorkflowDraft({
      id: created.id, expectedVersion: 1, definition: invalid,
    });

    expect(updated).toMatchObject({ version: 2, definition: { edges: [] } });
    expect(() => ledger.updateWorkflowDraft({
      id: created.id, expectedVersion: 1, definition: workflow(),
    })).toThrow(/version conflict/i);
  });

  it('publishes atomically with a server-owned monotonic logical revision', () => {
    const ledger = memoryLedger();
    ledger.recordWorkflowRevision({
      workflowId: 'draft-workflow', definition: workflow(7),
    });
    const draft = ledger.createWorkflowDraft({
      id: 'publish-draft', workflowId: 'draft-workflow', definition: workflow(99),
    });

    const published = ledger.publishWorkflowDraft({ id: draft.id, expectedVersion: 1 });
    expect(published.workflowRevision.definition).toMatchObject({ revision: 8 });
    expect(published.draft).toMatchObject({
      version: 2,
      publishedRevisionId: published.workflowRevision.id,
      definition: { revision: 8 },
    });
    expect(ledger.publishWorkflowDraft({ id: draft.id, expectedVersion: 1 }))
      .toEqual(published);
  });

  it('rolls back publication when the current draft is invalid', () => {
    const ledger = memoryLedger();
    const draft = ledger.createWorkflowDraft({
      id: 'invalid-draft', workflowId: 'draft-workflow',
      definition: { ...workflow(), edges: [] },
    });

    expect(() => ledger.publishWorkflowDraft({ id: draft.id, expectedVersion: 1 }))
      .toThrow(WorkflowDraftValidationError);
    expect(ledger.getWorkflowDraft(draft.id)).toMatchObject({ version: 1 });
    expect(ledger.listWorkflowRevisions('draft-workflow')).toEqual([]);
  });

  it('rolls publication back when its idempotent run key belongs to another run', () => {
    const ledger = memoryLedger();
    const existingRevision = ledger.recordWorkflowRevision({
      workflowId: 'draft-workflow', definition: workflow(),
    });
    ledger.createStartedRun({
      id: 'occupied-run-key', workflowRevisionId: existingRevision.id,
      workspace: process.cwd(), input: { objective: 'Existing run' },
    });
    const draft = ledger.createWorkflowDraft({
      id: 'atomic-launch-draft', workflowId: 'draft-workflow',
      definition: { ...workflow(), name: 'A different revision' },
    });

    expect(() => ledger.publishAndStartWorkflowDraft({
      id: draft.id,
      expectedVersion: draft.version,
      run: {
        id: 'occupied-run-key', workspace: process.cwd(),
        input: { objective: 'New run' },
      },
    })).toThrow(/already bound/i);
    expect(ledger.getWorkflowDraft(draft.id)).toMatchObject({ version: 1 });
    expect(ledger.getWorkflowDraft(draft.id)).not.toHaveProperty('publishedRevisionId');
    expect(ledger.listWorkflowRevisions('draft-workflow')).toHaveLength(1);
  });

  it('enforces bounded definitions and same-workflow base lineage', () => {
    const ledger = memoryLedger();
    const base = ledger.recordWorkflowRevision({
      workflowId: 'another-workflow', definition: { ...workflow(), id: 'another-workflow' },
    });
    expect(() => ledger.createWorkflowDraft({
      workflowId: 'draft-workflow', definition: workflow(), baseRevisionId: base.id,
    })).toThrow(/different workflow/i);
    expect(() => ledger.createWorkflowDraft({
      workflowId: 'draft-workflow',
      definition: {
        ...workflow(),
        nodes: Array.from({ length: 1_001 }, (_, index) => ({
          id: `node-${index}`, label: `Node ${index}`, kind: 'end',
        })),
      },
    })).toThrow(/too many nodes/i);
  });

  it('forks a published draft before editing and retains immutable lineage', () => {
    const ledger = memoryLedger();
    const controlPlane = new LocalControlPlane(ledger);
    const original = controlPlane.createWorkflowDraft({
      id: 'source-draft', workflowId: 'draft-workflow', definition: workflow(),
      proposedRunInput: { objective: 'Original task' },
    });
    const published = controlPlane.publishWorkflowDraft({
      id: original.id, expectedVersion: original.version,
    });
    const edited = controlPlane.updateWorkflowDraft({
      id: original.id,
      expectedVersion: published.draft.version,
      definition: { ...workflow(), name: 'Next draft' },
    });

    expect(edited.forkedFromDraftId).toBe(original.id);
    expect(edited.draft).toMatchObject({
      version: 1,
      baseRevisionId: published.workflowRevision.id,
      proposedRunInput: { objective: 'Original task' },
      definition: { name: 'Next draft' },
    });
    expect(edited.draft.id).not.toBe(original.id);
    expect(ledger.getWorkflowDraft(original.id)).toMatchObject({
      publishedRevisionId: published.workflowRevision.id,
      version: 2,
    });
  });
});
