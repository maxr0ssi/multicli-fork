import { z } from 'zod';

import type { LocalControlPlane } from './controlPlane/controlPlane.js';
import { workflowDraftCapabilities } from './controlPlane/workflowDraftCapabilities.js';
import {
  studioCliLaunchHandoff,
  type StudioCliLaunchHandoff,
} from './studio/launchCommand.js';
import type {
  PublishedWorkflowDraftView,
  WorkflowDraftSummary,
  WorkflowDraftUpdateResult,
  WorkflowDraftView,
} from './controlPlane/workflowDrafts.js';
import { agentCapForProfile, agentCapKey } from './workflows/agentCaps.js';
import type {
  WorkflowDraftDefinition,
} from './workflows/drafts.js';
import { describeWorkflowApi } from './workflows/dsl.js';
import {
  MAX_WORKFLOW_LABEL_LENGTH,
  MAX_WORKFLOW_NAME_LENGTH,
} from './workflows/inputShape.js';
import { isSafeLocalIdentifier } from './utils/safeIdentifier.js';

const identifierSchema = z.string().refine(isSafeLocalIdentifier, {
  message: 'Must be a safe local identifier (1–128 letters, numbers, dots, underscores, or hyphens).',
});
const nonEmptyString = z.string().refine(value => value.trim().length > 0, {
  message: 'Must contain non-whitespace text.',
});
const workflowNameSchema = nonEmptyString.max(MAX_WORKFLOW_NAME_LENGTH);
const workflowLabelSchema = nonEmptyString.max(MAX_WORKFLOW_LABEL_LENGTH);

const profileSchema = z.object({
  id: identifierSchema,
  label: workflowLabelSchema,
  role: z.enum(['builder', 'conductor', 'reviewer', 'researcher', 'custom']),
  provider: z.enum(['codex', 'claude']),
  model: nonEmptyString,
  reasoningEffort: nonEmptyString.optional(),
  workspaceAccess: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  selection: z.enum(['default', 'explicit-only']),
  enableSubagents: z.boolean().optional(),
  description: z.string().optional(),
}).strict();

const nodeBase = z.object({
  id: identifierSchema,
  label: workflowLabelSchema,
  description: z.string().optional(),
});

const nodeSchema = z.discriminatedUnion('kind', [
  nodeBase.extend({
    kind: z.literal('agent'),
    profileId: identifierSchema,
    prompt: nonEmptyString,
    maxAttempts: z.number().int().positive().optional(),
  }).strict(),
  nodeBase.extend({ kind: z.literal('fanout') }).strict(),
  nodeBase.extend({ kind: z.literal('join'), strategy: z.literal('all') }).strict(),
  nodeBase.extend({
    kind: z.literal('gate'),
    gate: z.enum(['manual', 'policy']),
    prompt: nonEmptyString,
  }).strict(),
  nodeBase.extend({ kind: z.literal('end') }).strict(),
]);

export const workflowDraftDefinitionSchema = z.object({
  id: identifierSchema,
  revision: z.number().int().positive().default(1).describe(
    'Draft placeholder only; publication assigns the next server-owned workflow revision.',
  ),
  name: workflowNameSchema,
  description: z.string().optional(),
  profiles: z.array(profileSchema).max(1_000),
  nodes: z.array(nodeSchema).max(1_000),
  edges: z.array(z.object({
    from: identifierSchema,
    to: identifierSchema,
    label: z.string().optional(),
  }).strict()).max(10_000),
  budget: z.object({
    maxModelCalls: z.number().int().positive().optional(),
    maxNodeAttempts: z.number().int().positive().optional(),
    maxEstimatedCostUsd: z.number().finite().positive().optional(),
    maxInputTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  }).strict().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
}).strict();

export type JsonValue = string | number | boolean | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const proposedWorkflowRunInputSchema = z.object({
  objective: nonEmptyString.describe('The exact task objective interpolated into {{objective}} prompts.'),
  acceptanceCriteria: z.array(nonEmptyString).optional(),
  constraints: z.array(nonEmptyString).optional(),
  context: jsonValueSchema.optional(),
  workspace: nonEmptyString.optional().describe(
    'Authoritative local execution workspace. MCP proposal tools replace this with their request cwd.',
  ),
}).catchall(jsonValueSchema);

export const workflowDraftProposalSchema = z.object({
  definition: workflowDraftDefinitionSchema.describe('The exact editable workflow definition to persist.'),
  proposedRunInput: proposedWorkflowRunInputSchema.describe(
    'Run input stored beside the definition; proposing does not start it.',
  ),
}).strict();

export type ProposedWorkflowRunInput = z.infer<typeof proposedWorkflowRunInputSchema>;
export type WorkflowDraftProposalInput = z.infer<typeof workflowDraftProposalSchema>;

export interface WorkflowDraftProposalHandoff {
  /** Exact SQLite authority the Studio process must reopen. */
  readonly storePath?: string;
}

export type WorkflowDraftStudioAvailability =
  | {
    readonly available: true;
    readonly launch: Pick<StudioCliLaunchHandoff, 'command' | 'args'>;
    readonly command: string;
    readonly purpose: string;
  }
  | {
    readonly available: false;
    readonly reason: string;
  };

type DraftControlPlane = Pick<LocalControlPlane,
  | 'createWorkflowDraft'
  | 'getWorkflowDraft'
  | 'listWorkflowDrafts'
  | 'updateWorkflowDraft'
  | 'publishWorkflowDraft'
>;

interface AgentSummary {
  readonly nodeId: string;
  readonly label: string;
  readonly profileId: string;
  readonly resolution: 'resolved' | 'unresolved';
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly workspaceAccess?: string;
  readonly enableSubagents?: boolean;
}

function summarizeAgents(definition: WorkflowDraftDefinition): readonly AgentSummary[] {
  const profiles = new Map(definition.profiles.map(profile => [profile.id, profile]));
  const agents: AgentSummary[] = [];
  for (const node of definition.nodes) {
    if (node.kind !== 'agent') continue;
    const profile = profiles.get(node.profileId);
    if (!profile) {
      agents.push({
        nodeId: node.id, label: node.label, profileId: node.profileId,
        resolution: 'unresolved',
      });
      continue;
    }
    agents.push({
      nodeId: node.id,
      label: node.label,
      profileId: profile.id,
      resolution: 'resolved',
      provider: profile.provider,
      model: profile.model,
      ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
      workspaceAccess: profile.workspaceAccess,
      enableSubagents: profile.enableSubagents === true,
    });
  }
  return agents;
}

function summarizeAssignments(definition: WorkflowDraftDefinition) {
  const profiles = new Map(definition.profiles.map(profile => [profile.id, profile]));
  const groups = new Map<string, {
    capKey: string;
    model: string;
    assigned: number;
    cap: number;
  }>();
  for (const node of definition.nodes) {
    if (node.kind !== 'agent') continue;
    const profile = profiles.get(node.profileId);
    if (!profile) continue;
    const key = agentCapKey(profile);
    const current = groups.get(key);
    groups.set(key, {
      capKey: key,
      model: profile.model,
      assigned: (current?.assigned ?? 0) + 1,
      cap: agentCapForProfile(profile),
    });
  }
  return [...groups.values()]
    .map(group => ({ ...group, withinCap: group.assigned <= group.cap }))
    .sort((left, right) => left.capKey.localeCompare(right.capKey));
}

function boundedItems<T>(items: readonly T[], limit: number) {
  return {
    items: items.slice(0, limit),
    omittedCount: Math.max(0, items.length - limit),
    truncated: items.length > limit,
  };
}

function studioAvailability(
  draftId: string,
  workspace: string | undefined,
  storePath: string | undefined,
): WorkflowDraftStudioAvailability {
  if (!workspace) {
    return { available: false, reason: 'Studio handoff requires an exact workspace.' };
  }
  if (!storePath) {
    return { available: false, reason: 'Studio handoff requires an exact file-backed SQLite store.' };
  }
  if (storePath === ':memory:') {
    return {
      available: false,
      reason: 'Studio handoff is unavailable because this draft uses an in-memory ledger.',
    };
  }
  const launch = studioCliLaunchHandoff({ draftId, workspace, storePath });
  return {
    available: true,
    launch: { command: launch.command, args: launch.args },
    command: launch.displayCommand,
    purpose: 'Open this durable draft to change agents, models, prompts, and topology before publishing.',
  };
}

function proposalResult(
  draft: WorkflowDraftView,
  handoff: WorkflowDraftProposalHandoff = {},
) {
  const definition = draft.definition;
  const runInput = draft.proposedRunInput as ProposedWorkflowRunInput;
  const kinds = { agent: 0, fanout: 0, join: 0, gate: 0, end: 0 };
  for (const node of definition.nodes) kinds[node.kind] += 1;
  const agents = summarizeAgents(definition);
  const agentLimit = 100;
  const edgeLimit = 200;
  const validationLimit = 100;
  const assignmentLimit = 100;
  const runInputFieldLimit = 50;
  const runInputFields = Object.keys(runInput).sort();
  const assignments = summarizeAssignments(definition);
  const workspace = typeof runInput.workspace === 'string' ? runInput.workspace : undefined;
  return {
    message: 'Here is the workflow I propose.',
    draft: {
      id: draft.id,
      workflowId: draft.workflowId,
      version: draft.version,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      validation: {
        valid: draft.validation.valid,
        issueCount: draft.validation.issues.length,
        ...boundedItems(draft.validation.issues, validationLimit),
      },
    },
    runInput: {
      stored: true,
      workspace,
      fields: boundedItems(runInputFields, runInputFieldLimit),
    },
    topology: {
      name: definition.name,
      nodeCount: definition.nodes.length,
      edgeCount: definition.edges.length,
      profileCount: definition.profiles.length,
      kinds,
      agents: boundedItems(agents, agentLimit),
      edges: boundedItems(
        definition.edges.map(edge => ({
          from: edge.from,
          to: edge.to,
        })),
        edgeLimit,
      ),
    },
    policy: {
      rules: describeWorkflowApi().policy,
      assignments: boundedItems(assignments, assignmentLimit),
      validationSource: 'local-workflow-validator' as const,
    },
    effects: {
      persisted: true,
      published: false,
      runStarted: false,
    },
    studio: studioAvailability(draft.id, workspace, handoff.storePath),
  };
}

export type WorkflowDraftProposalResult = ReturnType<typeof proposalResult>;

/** Machine-readable authoring contract; no runtime or ledger construction required. */
export function describeWorkflowDraftDesign(runtimeCapabilities?: unknown) {
  return {
    contractVersion: 1,
    workflowApi: describeWorkflowApi(),
    providerCapabilities: workflowDraftCapabilities(runtimeCapabilities),
    proposal: {
      tool: 'Create-Workflow-Draft',
      definitionSchema: z.toJSONSchema(workflowDraftDefinitionSchema),
      proposedRunInputSchema: z.toJSONSchema(proposedWorkflowRunInputSchema),
      effects: ['persist-editable-draft'],
      excludedEffects: ['publish-workflow', 'start-run', 'execute-model'],
      studioCommand:
        'multicli studio --draft <draftId> --workspace <workspace> --store <runStorePath>',
      studioAvailability: {
        requires: ['exact-workspace', 'file-backed-run-store'],
        unavailableFor: ['missing-authority', 'in-memory-run-store'],
      },
    },
  };
}

/** Explicit, side-effect-free-on-import facade over durable workflow drafts. */
export class WorkflowDraftService {
  constructor(private readonly controlPlane: DraftControlPlane) {}

  describe(runtimeCapabilities?: unknown) {
    return describeWorkflowDraftDesign(runtimeCapabilities);
  }

  propose(
    value: unknown,
    handoff: WorkflowDraftProposalHandoff = {},
  ): WorkflowDraftProposalResult {
    const input = workflowDraftProposalSchema.parse(value);
    const draft = this.controlPlane.createWorkflowDraft({
      workflowId: input.definition.id,
      definition: input.definition,
      proposedRunInput: input.proposedRunInput,
    });
    return proposalResult(draft, handoff);
  }

  get(id: string, expectedVersion?: number): WorkflowDraftView {
    return this.controlPlane.getWorkflowDraft(id, expectedVersion);
  }

  list(workflowId?: string): WorkflowDraftSummary[] {
    return this.controlPlane.listWorkflowDrafts(workflowId);
  }

  update(input: {
    id: string;
    expectedVersion: number;
    definition: WorkflowDraftDefinition;
    proposedRunInput?: ProposedWorkflowRunInput;
  }): WorkflowDraftUpdateResult {
    workflowDraftDefinitionSchema.parse(input.definition);
    const current = this.get(input.id, input.expectedVersion);
    if (input.definition.id !== current.workflowId) {
      throw new Error(
        `Workflow definition id must remain ${JSON.stringify(current.workflowId)} for this draft.`,
      );
    }
    if (input.proposedRunInput !== undefined) {
      proposedWorkflowRunInputSchema.parse(input.proposedRunInput);
    }
    return this.controlPlane.updateWorkflowDraft(input);
  }

  publish(id: string, expectedVersion: number): PublishedWorkflowDraftView {
    return this.controlPlane.publishWorkflowDraft({ id, expectedVersion });
  }
}

export function createWorkflowDraftService(controlPlane: DraftControlPlane): WorkflowDraftService {
  return new WorkflowDraftService(controlPlane);
}
