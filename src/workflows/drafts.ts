import type { WorkflowRevision, WorkflowRevisionInput } from './domain.js';

export type WorkflowDraftDefinition = WorkflowRevisionInput;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keep editor-facing collection fields structurally safe while allowing an
 * incomplete or disconnected graph to remain a durable draft.
 */
export function normalizeWorkflowDraftDefinition(
  workflowId: string,
  logicalRevision: number,
  value: unknown,
): WorkflowDraftDefinition {
  if (!isObject(value)) throw new Error('Workflow draft definition must be an object');
  if (typeof value.name !== 'string') {
    throw new Error('Workflow draft definition.name must be a string');
  }
  for (const field of ['profiles', 'nodes', 'edges'] as const) {
    if (!Array.isArray(value[field])) {
      throw new Error(`Workflow draft definition.${field} must be an array`);
    }
    if (value[field].some(item => !isObject(item))) {
      throw new Error(`Workflow draft definition.${field} entries must be objects`);
    }
  }
  return {
    ...value,
    id: workflowId,
    revision: logicalRevision,
  } as unknown as WorkflowRevisionInput;
}

export function workflowDraftRevision(value: unknown, fallback = 1): number {
  if (!isObject(value)) return fallback;
  return typeof value.revision === 'number'
    && Number.isInteger(value.revision)
    && value.revision > 0
    ? value.revision
    : fallback;
}

export function asWorkflowRevision(value: WorkflowDraftDefinition): WorkflowRevision {
  return value as WorkflowRevision;
}
