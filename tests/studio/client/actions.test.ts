import { afterEach, describe, expect, it, vi } from 'vitest';

import { visibleRunActions } from '../../../src/studio/client/actionVisibility.js';
import {
  runActionPath,
  StudioApi,
  workflowDraftConflictRecovery,
  workflowDraftPath,
} from '../../../src/studio/client/api.js';
import type { StudioRunView } from '../../../src/studio/contracts/studio.js';

function view(
  status: StudioRunView['run']['status'],
  allowed: Partial<Record<'pause' | 'resume' | 'cancel', boolean>>,
): StudioRunView {
  const availability = (action: 'pause' | 'resume' | 'cancel') => (
    allowed[action] ? { allowed: true as const } : { allowed: false as const, reason: 'not allowed' }
  );
  return {
    run: {
      status,
      allowedActions: {
        pause: availability('pause'),
        resume: availability('resume'),
        cancel: availability('cancel'),
      },
    },
  } as StudioRunView;
}

describe('Studio action targeting', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('shows only actions allowed by both durable state and server capability', () => {
    expect(visibleRunActions(view('running', { pause: true, resume: true, cancel: true })))
      .toEqual(['pause', 'cancel']);
    expect(visibleRunActions(view('waiting', { pause: true, resume: true, cancel: true })))
      .toEqual(['resume', 'cancel']);
    expect(visibleRunActions(view('completed', { pause: true, resume: true, cancel: true })))
      .toEqual([]);
  });

  it('builds the command path from the selected stable run id', () => {
    expect(runActionPath('run/selected id', 'pause'))
      .toBe('/api/v1/runs/run%2Fselected%20id/pause');
  });

  it('builds a draft path from the stable id rather than an array position', () => {
    expect(workflowDraftPath('draft/proposal 1'))
      .toBe('/api/v1/workflow-drafts/draft%2Fproposal%201');
  });

  it('preserves the complete proposed run input when starting a published draft', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'csrf' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: { id: 'run-1' } }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const api = new StudioApi();
    await api.connect();
    await api.startRun('revision-1', {
      objective: 'Build the editor',
      acceptanceCriteria: ['No fake telemetry', 'Immutable publish'],
    });

    const [, request] = fetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(request.body as string)).toEqual({
      workflowRevisionId: 'revision-1',
      input: {
        objective: 'Build the editor',
        acceptanceCriteria: ['No fake telemetry', 'Immutable publish'],
      },
    });
  });

  it('sends one stable key to the combined publish-and-start endpoint', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'csrf' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        draft: {}, workflowRevision: {}, run: { run: { id: 'stable-run' } }, runCreated: true,
      }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const api = new StudioApi();
    await api.connect();
    await api.publishAndStartWorkflowDraft('draft-1', 7, 'stable-run', {
      objective: 'Build it', constraints: ['No duplicate run'],
    });

    const [path, request] = fetch.mock.calls[1] as [string, RequestInit];
    expect(path).toBe('/api/v1/workflow-drafts/draft-1/publish-and-start');
    expect(JSON.parse(request.body as string)).toEqual({
      expectedVersion: 7,
      runId: 'stable-run',
      input: { objective: 'Build it', constraints: ['No duplicate run'] },
    });
  });

  it('recognizes only the bounded save-as-new-draft conflict command', async () => {
    const recovery = {
      action: 'save-as-new-draft',
      label: 'Save my changes as a new draft',
      command: {
        method: 'POST', path: '/api/v1/workflow-drafts',
        body: { workflowId: 'workflow-1', definition: {} },
      },
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'csrf' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'version conflict', currentVersion: 3, recovery,
      }), { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    const api = new StudioApi();
    await api.connect();
    const error = await api.updateWorkflowDraft('draft-1', 2, {} as any)
      .catch(reason => reason);

    expect(workflowDraftConflictRecovery(error)).toEqual(recovery);
  });
});
