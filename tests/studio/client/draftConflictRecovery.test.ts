import { describe, expect, it, vi } from 'vitest';

import type { WorkflowDraftView } from '../../../src/controlPlane/workflowDrafts.js';
import type { StudioApi, WorkflowDraftConflictRecovery } from '../../../src/studio/client/api.js';
import { persistConflictAsNewDraft } from '../../../src/studio/client/features/editor/useDraftAutosave.js';

describe('draft conflict recovery', () => {
  it('adopts the durable copy exactly once', async () => {
    const next = { id: 'copy-draft' } as WorkflowDraftView;
    const api = {
      saveWorkflowDraftConflictAsNewDraft: vi.fn().mockResolvedValue(next),
    } as unknown as StudioApi;
    const recovery = {
      action: 'save-as-new-draft', label: 'Save my changes as a new draft',
      command: {
        method: 'POST', path: '/api/v1/workflow-drafts',
        body: { workflowId: 'workflow-1', definition: {} as any },
      },
    } satisfies WorkflowDraftConflictRecovery;
    const onSaved = vi.fn();

    await expect(persistConflictAsNewDraft(
      api,
      recovery,
      {} as any,
      { objective: 'Keep this edit' },
      onSaved,
    )).resolves.toBe(next);
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledWith(next);
  });
});
