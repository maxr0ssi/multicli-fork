import type {
  StartedRunResponse,
  StudioArtifactPreview,
  StudioBootstrap,
  StudioRunAction,
  StudioRunView,
} from './types.js';
import type {
  PublishedWorkflowDraftView,
  WorkflowDraftUpdateResult,
  WorkflowDraftView,
} from '../../controlPlane/workflowDrafts.js';
import type { WorkflowDraftCapabilities } from '../../controlPlane/workflowDraftCapabilities.js';
import type { WorkflowDraftDefinition } from '../../workflows/drafts.js';

interface StudioSession {
  csrfToken: string | null;
}

export type RunEventHandler = () => void;

export interface WorkflowDraftConflictRecovery {
  readonly action: 'save-as-new-draft';
  readonly label: string;
  readonly command: {
    readonly method: 'POST';
    readonly path: '/api/v1/workflow-drafts';
    readonly body: {
      readonly workflowId: string;
      readonly definition: WorkflowDraftDefinition;
      readonly proposedRunInput?: unknown;
      readonly sourceRevisionId?: string;
    };
  };
}

export class StudioApiError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) {
    super(message);
    this.name = 'StudioApiError';
  }
}

export function workflowDraftConflictRecovery(
  error: unknown,
): WorkflowDraftConflictRecovery | undefined {
  if (!(error instanceof StudioApiError) || error.status !== 409
    || !error.body || typeof error.body !== 'object') return undefined;
  const recovery = (error.body as { recovery?: unknown }).recovery;
  if (!recovery || typeof recovery !== 'object') return undefined;
  const value = recovery as WorkflowDraftConflictRecovery;
  return value.action === 'save-as-new-draft'
    && value.command?.method === 'POST'
    && value.command.path === '/api/v1/workflow-drafts'
    && typeof value.command.body?.workflowId === 'string' ? value : undefined;
}

export function runActionPath(runId: string, action: StudioRunAction): string {
  return `/api/v1/runs/${encodeURIComponent(runId)}/${action}`;
}

export function workflowDraftPath(draftId: string): string {
  return `/api/v1/workflow-drafts/${encodeURIComponent(draftId)}`;
}

export class StudioApi {
  #csrfToken: string | null = null;

  async connect(): Promise<void> {
    const session = await this.#request<StudioSession>('/api/v1/session');
    this.#csrfToken = session.csrfToken;
  }

  overview(): Promise<StudioBootstrap> {
    return this.#request('/api/v1/studio/bootstrap');
  }

  run(runId: string): Promise<StudioRunView> {
    return this.#request(`/api/v1/runs/${encodeURIComponent(runId)}/view`);
  }

  controlRun(runId: string, action: StudioRunAction): Promise<unknown> {
    return this.#request(runActionPath(runId, action), { method: 'POST', body: '{}' });
  }

  startRun(workflowRevisionId: string, input: unknown): Promise<StartedRunResponse> {
    return this.#request('/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowRevisionId, input }),
    });
  }

  workflowDraft(draftId: string): Promise<WorkflowDraftView> {
    return this.#request(workflowDraftPath(draftId));
  }

  workflowDraftCapabilities(): Promise<WorkflowDraftCapabilities> {
    return this.#request('/api/v1/workflow-drafts/capabilities');
  }

  createWorkflowDraft(sourceRevisionId: string): Promise<WorkflowDraftView> {
    return this.#request('/api/v1/workflow-drafts', {
      method: 'POST',
      body: JSON.stringify({ sourceRevisionId }),
    });
  }

  updateWorkflowDraft(
    draftId: string,
    expectedVersion: number,
    definition: WorkflowDraftDefinition,
    proposedRunInput?: unknown,
  ): Promise<WorkflowDraftUpdateResult> {
    return this.#request(workflowDraftPath(draftId), {
      method: 'PUT',
      body: JSON.stringify({ expectedVersion, definition, proposedRunInput }),
    });
  }

  publishWorkflowDraft(
    draftId: string,
    expectedVersion: number,
  ): Promise<PublishedWorkflowDraftView> {
    return this.#request(`${workflowDraftPath(draftId)}/publish`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion }),
    });
  }

  publishAndStartWorkflowDraft(
    draftId: string,
    expectedVersion: number,
    runId: string,
    input: unknown,
  ): Promise<PublishedWorkflowDraftView & {
    readonly run: StartedRunResponse;
    readonly runCreated: boolean;
  }> {
    return this.#request(`${workflowDraftPath(draftId)}/publish-and-start`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion, runId, input }),
    });
  }

  saveWorkflowDraftConflictAsNewDraft(
    recovery: WorkflowDraftConflictRecovery,
    definition: WorkflowDraftDefinition,
    proposedRunInput: unknown,
  ): Promise<WorkflowDraftView> {
    return this.#request('/api/v1/workflow-drafts', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: recovery.command.body.workflowId,
        definition,
        proposedRunInput,
        ...(recovery.command.body.sourceRevisionId
          ? { sourceRevisionId: recovery.command.body.sourceRevisionId } : {}),
      }),
    });
  }

  resolveApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    actionHash: string,
  ): Promise<unknown> {
    return this.#request(`/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ decision, actionHash }),
    });
  }

  artifactPreview(runId: string, artifactId: string): Promise<StudioArtifactPreview> {
    return this.#request(
      `/api/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/content`,
    );
  }

  sendGoalInstruction(sessionId: string, instruction: string): Promise<unknown> {
    return this.#request(`/api/v1/goal-sessions/${encodeURIComponent(sessionId)}/instructions`, {
      method: 'POST',
      body: JSON.stringify({ instruction }),
    });
  }

  openGoalSession(runId: string, profileId: string, goal: string): Promise<unknown> {
    return this.#request('/api/v1/goal-sessions', {
      method: 'POST',
      body: JSON.stringify({ runId, profileId, goal }),
    });
  }

  closeGoalSession(sessionId: string): Promise<unknown> {
    return this.#request(`/api/v1/goal-sessions/${encodeURIComponent(sessionId)}/close`, {
      method: 'POST',
      body: '{}',
    });
  }

  events(
    runId: string,
    afterSequence: number,
    onEvent: RunEventHandler,
    onError?: RunEventHandler,
  ): () => void {
    const path = `/api/v1/runs/${encodeURIComponent(runId)}/events?after=${afterSequence}`;
    const source = new EventSource(path);
    source.addEventListener('run-event', onEvent);
    if (onError) source.addEventListener('error', onError);
    return () => source.close();
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (this.#csrfToken && init.method && init.method !== 'GET') {
      headers.set('x-multicli-csrf', this.#csrfToken);
    }
    const response = await fetch(path, { ...init, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new StudioApiError(
        response.status,
        body,
        body.error || `Studio request failed (${response.status})`,
      );
    }
    return response.json() as Promise<T>;
  }
}
