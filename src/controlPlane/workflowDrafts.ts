import type {
  PublishedWorkflowDraft,
  WorkflowDraftRecord,
  WorkflowRevisionRecord,
} from '../persistence/runLedger.js';
import type { WorkflowDraftDefinition } from '../workflows/drafts.js';
import {
  type WorkflowValidationResult,
} from '../workflows/graph.js';
import { validateLocalWorkflowRevision } from '../workflows/localModelPolicy.js';

export interface WorkflowDraftView extends Omit<WorkflowDraftRecord, 'definition'> {
  readonly definition: WorkflowDraftDefinition;
  readonly validation: WorkflowValidationResult;
}

export interface PublishedWorkflowDraftView {
  readonly draft: WorkflowDraftView;
  readonly workflowRevision: WorkflowRevisionRecord;
}

export interface WorkflowDraftSummary {
  readonly id: string;
  readonly workflowId: string;
  readonly version: number;
  readonly name: string;
  readonly nodeCount: number;
  readonly agentCount: number;
  readonly validation: {
    readonly valid: boolean;
    readonly issueCount: number;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly baseRevisionId?: string;
  readonly publishedRevisionId?: string;
}

export interface WorkflowDraftUpdateResult {
  readonly draft: WorkflowDraftView;
  readonly forkedFromDraftId?: string;
}

export function workflowDraftView(record: WorkflowDraftRecord): WorkflowDraftView {
  return {
    ...record,
    definition: record.definition as WorkflowDraftDefinition,
    validation: validateLocalWorkflowRevision(record.definition),
  };
}

export function publishedWorkflowDraftView(
  result: PublishedWorkflowDraft,
): PublishedWorkflowDraftView {
  return {
    draft: workflowDraftView(result.draft),
    workflowRevision: result.workflowRevision,
  };
}

export function workflowDraftSummary(record: WorkflowDraftRecord): WorkflowDraftSummary {
  const view = workflowDraftView(record);
  const definition = view.definition && typeof view.definition === 'object'
    ? view.definition as unknown as Record<string, unknown>
    : {};
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
  const name = typeof definition.name === 'string' && definition.name.trim()
    ? definition.name.trim()
    : 'Untitled workflow';
  return {
    id: view.id,
    workflowId: view.workflowId,
    version: view.version,
    name,
    nodeCount: nodes.length,
    agentCount: nodes.filter(node => (
      node !== null
      && typeof node === 'object'
      && !Array.isArray(node)
      && (node as Record<string, unknown>).kind === 'agent'
    )).length,
    validation: { valid: view.validation.valid, issueCount: view.validation.issues.length },
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    ...(view.baseRevisionId ? { baseRevisionId: view.baseRevisionId } : {}),
    ...(view.publishedRevisionId
      ? { publishedRevisionId: view.publishedRevisionId } : {}),
  };
}
