import { isSafeLocalIdentifier } from '../utils/localIdentifier.js';
import type { WorkflowEdge } from './domain.js';
import {
  CLAUDE_REASONING_EFFORTS,
  CODEX_REASONING_EFFORTS,
  modelRequiresExplicitSelection,
  reasoningEffortsForWorkflowModel,
} from './providerPolicy.js';

export interface WorkflowInputShapeIssue {
  readonly code:
    | 'invalid-workflow-id'
    | 'invalid-workflow-name'
    | 'invalid-metadata'
    | 'invalid-profile'
    | 'invalid-node'
    | 'invalid-edge'
    | 'invalid-budget';
  readonly message: string;
  readonly nodeId?: string;
  readonly edge?: WorkflowEdge;
}

const ROLES = new Set(['builder', 'conductor', 'reviewer', 'researcher', 'custom']);
const ACCESS = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const SELECTIONS = new Set(['default', 'explicit-only']);
const BUDGET_KEYS = new Set([
  'maxModelCalls',
  'maxNodeAttempts',
  'maxEstimatedCostUsd',
  'maxInputTokens',
  'maxOutputTokens',
]);
const INTEGER_BUDGET_KEYS = new Set([
  'maxModelCalls',
  'maxNodeAttempts',
  'maxInputTokens',
  'maxOutputTokens',
]);

export const MAX_WORKFLOW_NAME_LENGTH = 200;
export const MAX_WORKFLOW_LABEL_LENGTH = 160;
export const MAX_WORKFLOW_PROMPT_BYTES = 200_000;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalStringValid(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function modelSegments(model: string): Set<string> {
  return new Set(model.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function profileIssues(profile: Record<string, unknown>): WorkflowInputShapeIssue[] {
  const issues: WorkflowInputShapeIssue[] = [];
  const label = `Profile ${JSON.stringify(profile.id)}`;
  if (nonEmptyString(profile.id) && !isSafeLocalIdentifier(profile.id)) {
    issues.push({ code: 'invalid-profile', message: `${label} has an unsafe local id.` });
  }
  if (!nonEmptyString(profile.label)) {
    issues.push({ code: 'invalid-profile', message: `${label} needs a non-empty label.` });
  } else if (profile.label.length > MAX_WORKFLOW_LABEL_LENGTH) {
    issues.push({ code: 'invalid-profile', message: `${label} label is too long.` });
  }
  if (typeof profile.role !== 'string' || !ROLES.has(profile.role)) {
    issues.push({ code: 'invalid-profile', message: `${label} has an unsupported role.` });
  }
  if (typeof profile.workspaceAccess !== 'string' || !ACCESS.has(profile.workspaceAccess)) {
    issues.push({ code: 'invalid-profile', message: `${label} has invalid workspaceAccess.` });
  }
  if (typeof profile.selection !== 'string' || !SELECTIONS.has(profile.selection)) {
    issues.push({ code: 'invalid-profile', message: `${label} has an invalid selection policy.` });
  }
  if (profile.reasoningEffort !== undefined && !nonEmptyString(profile.reasoningEffort)) {
    issues.push({ code: 'invalid-profile', message: `${label} reasoningEffort must be a non-empty string.` });
  }
  if (profile.provider === 'codex' && nonEmptyString(profile.reasoningEffort)) {
    const modelEfforts = nonEmptyString(profile.model)
      ? reasoningEffortsForWorkflowModel('codex', profile.model)
      : [];
    const supported = modelEfforts.length > 0 ? modelEfforts : CODEX_REASONING_EFFORTS;
    if (!supported.includes(profile.reasoningEffort)) {
      issues.push({ code: 'invalid-profile', message: `${label} has an unsupported Codex reasoningEffort.` });
    }
  }
  if (profile.provider === 'claude' && nonEmptyString(profile.reasoningEffort)
    && !CLAUDE_REASONING_EFFORTS.includes(profile.reasoningEffort as never)) {
    issues.push({ code: 'invalid-profile', message: `${label} has an unsupported Claude thinking level.` });
  }
  if (profile.enableSubagents !== undefined && typeof profile.enableSubagents !== 'boolean') {
    issues.push({ code: 'invalid-profile', message: `${label} enableSubagents must be boolean.` });
  }
  if (!optionalStringValid(profile.description)) {
    issues.push({ code: 'invalid-profile', message: `${label} description must be a string.` });
  }

  if (profile.provider !== 'codex' && profile.provider !== 'claude') {
    issues.push({ code: 'invalid-profile', message: `${label} has no supported local provider adapter.` });
  }
  if (profile.provider === 'claude' && profile.workspaceAccess === 'danger-full-access') {
    issues.push({ code: 'invalid-profile', message: `${label} cannot use Claude with danger-full-access.` });
  }
  if (nonEmptyString(profile.model)
    && ((profile.provider === 'claude' && !profile.model.startsWith('claude-'))
      || (profile.provider === 'codex' && profile.model.startsWith('claude-')))) {
    issues.push({ code: 'invalid-profile', message: `${label} model is incompatible with its provider.` });
  }

  if (nonEmptyString(profile.model)) {
    const segments = modelSegments(profile.model);
    if (segments.has('fable')) {
      issues.push({ code: 'invalid-profile', message: `${label} selects Fable, which is disabled for workflows.` });
    }
    if (modelRequiresExplicitSelection(profile.model) && profile.selection !== 'explicit-only') {
      issues.push({ code: 'invalid-profile', message: `${label} must mark Terra as explicit-only.` });
    }
  }
  return issues;
}

function nodeIssues(node: Record<string, unknown>): WorkflowInputShapeIssue[] {
  const issues: WorkflowInputShapeIssue[] = [];
  const nodeId = nonEmptyString(node.id) ? node.id : undefined;
  const label = `Node ${JSON.stringify(node.id)}`;
  if (nonEmptyString(node.label) && node.label.length > MAX_WORKFLOW_LABEL_LENGTH) {
    issues.push({ code: 'invalid-node', message: `${label} label is too long.`, nodeId });
  }
  if (!optionalStringValid(node.description)) {
    issues.push({ code: 'invalid-node', message: `${label} description must be a string.`, nodeId });
  }
  if (node.kind === 'agent' && !nonEmptyString(node.profileId)) {
    issues.push({ code: 'invalid-node', message: `${label} needs a non-empty profileId.`, nodeId });
  }
  if (node.kind === 'gate' && !nonEmptyString(node.prompt)) {
    issues.push({ code: 'invalid-node', message: `${label} needs a non-empty gate prompt.`, nodeId });
  }
  if ((node.kind === 'agent' || node.kind === 'gate') && typeof node.prompt === 'string'
    && new TextEncoder().encode(node.prompt).byteLength > MAX_WORKFLOW_PROMPT_BYTES) {
    issues.push({ code: 'invalid-node', message: `${label} prompt is too large.`, nodeId });
  }
  return issues;
}

/** Validate fields that the graph topology walk must not consume through unchecked casts. */
export function validateWorkflowInputShape(value: unknown): readonly WorkflowInputShapeIssue[] {
  const definition = objectValue(value);
  if (!definition) return [];
  const issues: WorkflowInputShapeIssue[] = [];
  if (nonEmptyString(definition.id) && !isSafeLocalIdentifier(definition.id)) {
    issues.push({ code: 'invalid-workflow-id', message: 'Workflow id is not a safe local identifier.' });
  }
  if (nonEmptyString(definition.name) && definition.name.length > MAX_WORKFLOW_NAME_LENGTH) {
    issues.push({ code: 'invalid-workflow-name', message: 'Workflow name is too long.' });
  }
  if (!optionalStringValid(definition.description)) {
    issues.push({ code: 'invalid-workflow-name', message: 'Workflow description must be a string.' });
  }
  if (Array.isArray(definition.profiles)) {
    for (const profile of definition.profiles) {
      const object = objectValue(profile);
      if (object) issues.push(...profileIssues(object));
    }
  }
  if (Array.isArray(definition.nodes)) {
    for (const node of definition.nodes) {
      const object = objectValue(node);
      if (object) issues.push(...nodeIssues(object));
    }
  }
  if (Array.isArray(definition.edges)) {
    for (const rawEdge of definition.edges) {
      const edge = objectValue(rawEdge);
      if (edge && !optionalStringValid(edge.label)) {
        issues.push({
          code: 'invalid-edge',
          message: 'Edge label must be a string.',
          edge: rawEdge as WorkflowEdge,
        });
      } else if (edge && typeof edge.label === 'string'
        && edge.label.length > MAX_WORKFLOW_LABEL_LENGTH) {
        issues.push({
          code: 'invalid-edge',
          message: 'Edge label is too long.',
          edge: rawEdge as WorkflowEdge,
        });
      }
    }
  }
  if (definition.metadata !== undefined) {
    const metadata = objectValue(definition.metadata);
    if (!metadata || Object.values(metadata).some(entry => typeof entry !== 'string')) {
      issues.push({ code: 'invalid-metadata', message: 'Workflow metadata must contain only string values.' });
    }
  }
  const budget = objectValue(definition.budget);
  if (budget) {
    for (const [key, value] of Object.entries(budget)) {
      if (!BUDGET_KEYS.has(key)) {
        issues.push({ code: 'invalid-budget', message: `Unsupported workflow budget field: ${key}.` });
      } else if (INTEGER_BUDGET_KEYS.has(key)
        && (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
        issues.push({ code: 'invalid-budget', message: `Budget ${key} must be a positive integer.` });
      }
    }
  }
  return issues;
}
