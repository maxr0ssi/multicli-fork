import {
  defineWorkflowProfile,
  defineWorkflowRevision,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowProfile,
  type WorkflowRevision,
} from './domain.js';

/** Default builder: Luna is selected deliberately at MAX reasoning effort. */
export const LUNA_MAX_BUILDER_PROFILE: WorkflowProfile = defineWorkflowProfile({
  id: 'luna-max-builder',
  label: 'Luna / MAX builder',
  role: 'builder',
  provider: 'codex',
  model: 'gpt-5.6-luna',
  reasoningEffort: 'max',
  workspaceAccess: 'workspace-write',
  selection: 'default',
  enableSubagents: false,
  description: 'Primary implementation lane for bounded workspace changes.',
});

/** Sol coordinates the council and stays read-only unless a revision opts in. */
export const SOL_CONDUCTOR_PROFILE: WorkflowProfile = defineWorkflowProfile({
  id: 'sol-conductor',
  label: 'Sol conductor',
  role: 'conductor',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  workspaceAccess: 'read-only',
  selection: 'default',
  enableSubagents: false,
  description: 'Plans, delegates, and synthesizes without becoming a default writer.',
});

/** Terra exists for intentional routing; automatic default selection must skip it. */
export const TERRA_EXPLICIT_ONLY_PROFILE: WorkflowProfile = defineWorkflowProfile({
  id: 'terra-explicit-only',
  label: 'Terra (explicit only)',
  role: 'reviewer',
  provider: 'codex',
  model: 'gpt-5.6-terra',
  reasoningEffort: 'high',
  workspaceAccess: 'read-only',
  selection: 'explicit-only',
  enableSubagents: false,
  description: 'Available only when a workflow author deliberately assigns Terra.',
});

export const SONNET_EXPLICIT_PROFILE: WorkflowProfile = defineWorkflowProfile({
  id: 'sonnet-reviewer',
  label: 'Claude Sonnet reviewer',
  role: 'reviewer',
  provider: 'claude',
  model: 'claude-sonnet-5',
  reasoningEffort: 'high',
  workspaceAccess: 'read-only',
  selection: 'explicit-only',
  enableSubagents: false,
  description: 'Balanced Claude review lane selected explicitly by a workflow author.',
});

export const OPUS_EXPLICIT_PROFILE: WorkflowProfile = defineWorkflowProfile({
  id: 'opus-reviewer',
  label: 'Claude Opus reviewer',
  role: 'reviewer',
  provider: 'claude',
  model: 'claude-opus-5',
  reasoningEffort: 'high',
  workspaceAccess: 'read-only',
  selection: 'explicit-only',
  enableSubagents: false,
  description: 'High-depth Claude review or adjudication lane.',
});

export const ALTERNATIVE_WORKFLOW_PROFILES: readonly WorkflowProfile[] = Object.freeze([
  SONNET_EXPLICIT_PROFILE,
  OPUS_EXPLICIT_PROFILE,
  TERRA_EXPLICIT_ONLY_PROFILE,
]);

export const DEFAULT_COUNCIL_PROFILES: readonly WorkflowProfile[] = Object.freeze([
  SOL_CONDUCTOR_PROFILE,
  LUNA_MAX_BUILDER_PROFILE,
]);

export interface LunaBuildCouncilOptions {
  readonly id?: string;
  readonly revision?: number;
  readonly name?: string;
  /** Two to twenty independent Luna/MAX implementation lanes. Defaults to five. */
  readonly builderCount?: number;
}

/**
 * Canonical fanout workflow: Sol scopes the objective, a council of Luna/MAX
 * builders work in bounded lanes, their artifacts join, Sol synthesizes the
 * combined result, and an explicit gate guards completion. Terra is available
 * in the profile catalog but is deliberately not auto-assigned.
 */
export function createLunaBuildCouncilDefinition(
  options: LunaBuildCouncilOptions = {},
): WorkflowRevision {
  const builderCount = options.builderCount ?? 5;
  if (!Number.isInteger(builderCount) || builderCount < 2 || builderCount > 20) {
    throw new RangeError('Luna build council requires between two and twenty builder lanes.');
  }

  const builderNodes: WorkflowNode[] = Array.from({ length: builderCount }, (_, index) => ({
    id: `luna-builder-${index + 1}`,
    label: `Luna/MAX builder ${index + 1}`,
    kind: 'agent' as const,
    profileId: LUNA_MAX_BUILDER_PROFILE.id,
    prompt:
      `Implement Luna lane ${index + 1} of ${builderCount} for {{objective}}. ` +
      'Read the Sol plan and prior local artifacts, avoid duplicating completed lanes, ' +
      'and record durable implementation and verification evidence for the council.',
    maxAttempts: 2,
  }));

  const nodes: WorkflowNode[] = [
    {
      id: 'sol-conductor',
      label: 'Sol conductor',
      kind: 'agent',
      profileId: SOL_CONDUCTOR_PROFILE.id,
      prompt:
        `Break {{objective}} into exactly ${builderCount} numbered implementation lanes, ` +
        'define acceptance criteria for each, and dispatch the Luna council.',
      maxAttempts: 1,
    },
    {
      id: 'dispatch-luna-council',
      label: 'Dispatch Luna build council',
      kind: 'fanout',
    },
    ...builderNodes,
    {
      id: 'join-luna-council',
      label: 'Join Luna build council',
      kind: 'join',
      strategy: 'all',
    },
    {
      id: 'sol-synthesis',
      label: 'Sol council synthesis',
      kind: 'agent',
      profileId: SOL_CONDUCTOR_PROFILE.id,
      prompt:
        'Synthesize every Luna artifact for {{objective}}. Check the combined workspace and test evidence, identify unresolved conflicts or gaps, and produce a concise review packet for the human gate.',
      maxAttempts: 1,
    },
    {
      id: 'review-gate',
      label: 'Review implementation council',
      kind: 'gate',
      gate: 'manual',
      prompt: 'Review the joined artifacts, test evidence, and proposed workspace changes before completion.',
    },
    {
      id: 'complete',
      label: 'Complete workflow',
      kind: 'end',
    },
  ];

  const edges: WorkflowEdge[] = [
    { from: 'sol-conductor', to: 'dispatch-luna-council' },
    ...builderNodes.map((node) => ({ from: 'dispatch-luna-council', to: node.id })),
    ...builderNodes.map((node) => ({ from: node.id, to: 'join-luna-council' })),
    { from: 'join-luna-council', to: 'sol-synthesis' },
    { from: 'sol-synthesis', to: 'review-gate' },
    { from: 'review-gate', to: 'complete' },
  ];

  return defineWorkflowRevision({
    id: options.id ?? 'luna-build-council',
    revision: options.revision ?? 1,
    name: options.name ?? 'Luna Build Council',
    description: 'Sol-conducted Luna/MAX implementation fanout, synthesis, and explicit review gate.',
    profiles: [
      SOL_CONDUCTOR_PROFILE,
      LUNA_MAX_BUILDER_PROFILE,
      TERRA_EXPLICIT_ONLY_PROFILE,
      SONNET_EXPLICIT_PROFILE,
      OPUS_EXPLICIT_PROFILE,
    ],
    nodes,
    edges,
    budget: {
      maxModelCalls: 2 + builderCount * 2,
      maxNodeAttempts: 2 + builderCount * 2,
      maxEstimatedCostUsd: 50,
    },
    metadata: {
      template: 'luna-build-council',
      terraRouting: 'explicit-only',
      harness: 'repository',
    },
  });
}

/** Stable default definition for callers that do not need custom lane counts. */
export const LUNA_BUILD_COUNCIL: WorkflowRevision = createLunaBuildCouncilDefinition();
