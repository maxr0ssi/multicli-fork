import type { WorkspaceAccess } from './domain.js';

export const CODEX_WORKFLOW_MODELS = Object.freeze([
  'gpt-5.6-sol',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
] as const);

export const CLAUDE_WORKFLOW_MODELS = Object.freeze([
  'claude-opus-5',
  'claude-sonnet-5',
] as const);

export const CODEX_REASONING_EFFORTS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const);

export const CLAUDE_REASONING_EFFORTS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const);

const LUNA_REASONING_EFFORTS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const);

export function reasoningEffortsForWorkflowModel(
  provider: 'codex' | 'claude',
  model: string,
): readonly string[] {
  if (provider === 'claude') {
    return CLAUDE_WORKFLOW_MODELS.includes(model as never)
      ? CLAUDE_REASONING_EFFORTS
      : [];
  }
  if (model === 'gpt-5.6-luna') return LUNA_REASONING_EFFORTS;
  return model === 'gpt-5.6-sol' || model === 'gpt-5.6-terra'
    ? CODEX_REASONING_EFFORTS
    : [];
}

export const CODEX_WORKSPACE_ACCESS = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access',
] satisfies readonly WorkspaceAccess[]);

export const CLAUDE_WORKSPACE_ACCESS = Object.freeze([
  'read-only',
  'workspace-write',
] satisfies readonly WorkspaceAccess[]);

export function modelRequiresExplicitSelection(model: string): boolean {
  return new Set(model.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)).has('terra');
}
