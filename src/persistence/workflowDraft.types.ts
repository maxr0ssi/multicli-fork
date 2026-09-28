/** A locally durable, editable workflow proposal. Invalid graph states may be saved. */
export interface WorkflowDraftRecord {
  id: string;
  workflowId: string;
  /** Optimistic concurrency token. Every successful mutation advances it. */
  version: number;
  definition: unknown;
  proposedRunInput?: unknown;
  createdAt: string;
  updatedAt: string;
  /** Immutable revision this draft was forked from, when applicable. */
  baseRevisionId?: string;
  /** Present only when the current draft content has been published unchanged. */
  publishedRevisionId?: string;
}

export interface CreateWorkflowDraftInput {
  id?: string;
  workflowId: string;
  definition: unknown;
  proposedRunInput?: unknown;
  baseRevisionId?: string;
  createdAt?: string;
}

export interface UpdateWorkflowDraftInput {
  id: string;
  expectedVersion: number;
  definition: unknown;
  proposedRunInput?: unknown;
  updatedAt?: string;
}

export interface PublishWorkflowDraftInput {
  id: string;
  expectedVersion: number;
  publishedAt?: string;
}

/** One retry-safe command whose caller-owned run id is also its idempotency key. */
export interface PublishAndStartWorkflowDraftInput extends PublishWorkflowDraftInput {
  run: {
    id: string;
    workspace: string;
    input?: unknown;
    parentRunId?: string;
    createdAt?: string;
  };
}
