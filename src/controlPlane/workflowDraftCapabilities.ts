import type { WorkspaceAccess } from '../workflows/domain.js';
import { cataloguedWorkflowModels } from '../workflows/localModelPolicy.js';
import { validateLocalWorkflowRevision } from '../workflows/localModelPolicy.js';
import type { WorkflowValidationResult } from '../workflows/graph.js';
import {
  CLAUDE_REASONING_EFFORTS,
  CLAUDE_WORKSPACE_ACCESS,
  CODEX_REASONING_EFFORTS,
  CODEX_WORKSPACE_ACCESS,
  reasoningEffortsForWorkflowModel,
} from '../workflows/providerPolicy.js';

export interface WorkflowDraftProviderCapability {
  readonly id: 'codex' | 'claude';
  readonly label: string;
  readonly models: readonly {
    readonly id: string;
    readonly reasoningEfforts: readonly string[];
  }[];
  readonly reasoningEfforts: readonly string[];
  readonly workspaceAccess: readonly WorkspaceAccess[];
  readonly supportsSubagents: boolean;
  /** Runtime CLI presence, kept separate from the checked-in model catalog. */
  readonly availability: 'available' | 'unavailable' | 'unknown';
}

export interface WorkflowDraftCapabilities {
  readonly providers: readonly WorkflowDraftProviderCapability[];
}

export class WorkflowStartPreflightError extends Error {
  readonly validation: WorkflowValidationResult;

  constructor(validation: WorkflowValidationResult) {
    super(`Workflow cannot start: ${validation.issues.map(issue => issue.message).join(' ')}`);
    this.name = 'WorkflowStartPreflightError';
    this.validation = validation;
  }
}

function runtimeAvailability(
  runtimeCapabilities: unknown,
  provider: 'codex' | 'claude',
): WorkflowDraftProviderCapability['availability'] {
  if (!runtimeCapabilities || typeof runtimeCapabilities !== 'object') return 'unknown';
  const availability = (runtimeCapabilities as { cliAvailability?: unknown }).cliAvailability;
  if (!availability || typeof availability !== 'object') return 'unknown';
  const value = (availability as Record<string, unknown>)[provider];
  return typeof value === 'boolean' ? value ? 'available' : 'unavailable' : 'unknown';
}

export function workflowDraftCapabilities(
  runtimeCapabilities?: unknown,
): WorkflowDraftCapabilities {
  return {
    providers: [
      {
        id: 'codex',
        label: 'Codex',
        models: cataloguedWorkflowModels('codex').map(id => ({
          id,
          reasoningEfforts: reasoningEffortsForWorkflowModel('codex', id),
        })),
        reasoningEfforts: CODEX_REASONING_EFFORTS,
        workspaceAccess: CODEX_WORKSPACE_ACCESS,
        supportsSubagents: true,
        availability: runtimeAvailability(runtimeCapabilities, 'codex'),
      },
      {
        id: 'claude',
        label: 'Claude',
        models: cataloguedWorkflowModels('claude').map(id => ({
          id,
          reasoningEfforts: reasoningEffortsForWorkflowModel('claude', id),
        })),
        reasoningEfforts: CLAUDE_REASONING_EFFORTS,
        workspaceAccess: CLAUDE_WORKSPACE_ACCESS,
        supportsSubagents: true,
        availability: runtimeAvailability(runtimeCapabilities, 'claude'),
      },
    ],
  };
}

export function preflightWorkflowStart(
  definition: unknown,
  runtimeCapabilities?: unknown,
): WorkflowValidationResult {
  const validation = validateLocalWorkflowRevision(definition);
  const issues = [...validation.issues];
  if (!definition || typeof definition !== 'object'
    || !Array.isArray((definition as { profiles?: unknown }).profiles)) {
    return validation;
  }
  const unavailable = new Set<'codex' | 'claude'>();
  const candidate = definition as { profiles: unknown[]; nodes?: unknown };
  const assignedProfileIds = new Set(
    (Array.isArray(candidate.nodes) ? candidate.nodes : [])
      .filter(node => node && typeof node === 'object'
        && (node as { kind?: unknown }).kind === 'agent')
      .map(node => (node as { profileId?: unknown }).profileId)
      .filter((id): id is string => typeof id === 'string'),
  );
  for (const profile of candidate.profiles) {
    if (!profile || typeof profile !== 'object') continue;
    if (!assignedProfileIds.has(String((profile as { id?: unknown }).id))) continue;
    const provider = (profile as { provider?: unknown }).provider;
    if ((provider === 'codex' || provider === 'claude')
      && runtimeAvailability(runtimeCapabilities, provider) === 'unavailable') {
      unavailable.add(provider);
    }
  }
  for (const provider of unavailable) {
    issues.push({
      code: 'invalid-profile',
      message: `The ${provider} CLI is not available in this local runtime.`,
    });
  }
  return { valid: issues.length === 0, issues };
}
