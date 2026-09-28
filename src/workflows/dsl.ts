import {
  defineWorkflowProfile,
  defineWorkflowRevision,
  type AgentRole,
  type WorkflowBudget,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowProfile,
  type WorkflowRevision,
  type WorkspaceAccess,
} from './domain.js';
import { validateWorkflowRevision } from './graph.js';
import {
  LUNA_MAX_BUILDER_PROFILE,
  OPUS_EXPLICIT_PROFILE,
  SOL_CONDUCTOR_PROFILE,
  SONNET_EXPLICIT_PROFILE,
  TERRA_EXPLICIT_ONLY_PROFILE,
} from './lunaBuildCouncil.js';
import { agentCapForProfile, WORKFLOW_AGENT_CAPS } from './agentCaps.js';

export interface ProfileFactoryOptions {
  /** Set a distinct id when the same model needs different permissions or roles. */
  readonly id?: string;
  readonly label?: string;
  readonly role?: AgentRole;
  readonly workspaceAccess?: WorkspaceAccess;
  readonly enableSubagents?: boolean;
  readonly description?: string;
}

function profileFrom(
  base: WorkflowProfile,
  options: ProfileFactoryOptions = {},
): WorkflowProfile {
  return defineWorkflowProfile({
    ...base,
    ...options,
    // A factory never changes provider, model, reasoning, or selection policy.
    provider: base.provider,
    model: base.model,
    ...(base.reasoningEffort ? { reasoningEffort: base.reasoningEffort } : {}),
    selection: base.selection,
  });
}

/** Explicit profile choices. Calling `terra()` is the only DSL route to Terra. */
export const profiles = Object.freeze({
  sol: (options?: ProfileFactoryOptions): WorkflowProfile =>
    profileFrom(SOL_CONDUCTOR_PROFILE, options),
  luna: (options?: ProfileFactoryOptions): WorkflowProfile =>
    profileFrom(LUNA_MAX_BUILDER_PROFILE, options),
  opus: (options?: ProfileFactoryOptions): WorkflowProfile =>
    profileFrom(OPUS_EXPLICIT_PROFILE, options),
  sonnet: (options?: ProfileFactoryOptions): WorkflowProfile =>
    profileFrom(SONNET_EXPLICIT_PROFILE, options),
  terra: (options?: ProfileFactoryOptions): WorkflowProfile =>
    profileFrom(TERRA_EXPLICIT_ONLY_PROFILE, options),
});

interface StepBase {
  readonly id: string;
  readonly label?: string;
  readonly description?: string;
}

export interface AgentStep extends StepBase {
  readonly kind: 'agent';
  readonly profile: WorkflowProfile;
  readonly prompt: string;
  readonly maxAttempts?: number;
}

export interface ParallelStep extends StepBase {
  readonly kind: 'parallel';
  readonly lanes: readonly WorkflowLane[];
}

export interface ReviewerAssignment {
  readonly profile: WorkflowProfile;
  /** Repeat this reviewer profile. Defaults to one. */
  readonly count?: number;
  readonly label?: string;
}

export interface ReviewStep extends StepBase {
  readonly kind: 'review';
  readonly prompt: string;
  readonly reviewers: readonly ReviewerAssignment[];
  readonly maxAttempts?: number;
}

export interface ApprovalStep extends StepBase {
  readonly kind: 'approval';
  readonly prompt: string;
  readonly gate: 'manual' | 'policy';
}

export type WorkflowStep = AgentStep | ParallelStep | ReviewStep | ApprovalStep;
export type WorkflowSequence = readonly WorkflowStep[];
export type WorkflowLane = WorkflowStep | WorkflowSequence;

export interface AgentStepOptions {
  readonly label?: string;
  readonly description?: string;
  readonly maxAttempts?: number;
}

export function agent(
  id: string,
  profile: WorkflowProfile,
  prompt: string,
  options: AgentStepOptions = {},
): AgentStep {
  return Object.freeze({ kind: 'agent', id, profile, prompt, ...options });
}

export function sequence(...steps: readonly WorkflowStep[]): WorkflowSequence {
  return Object.freeze([...steps]);
}

export interface ParallelStepOptions {
  readonly label?: string;
  readonly description?: string;
}

export function parallel(
  id: string,
  lanes: readonly WorkflowLane[],
  options: ParallelStepOptions = {},
): ParallelStep {
  return Object.freeze({ kind: 'parallel', id, lanes: Object.freeze([...lanes]), ...options });
}

export interface ReviewStepOptions {
  readonly prompt: string;
  readonly reviewers: readonly ReviewerAssignment[];
  readonly label?: string;
  readonly description?: string;
  readonly maxAttempts?: number;
}

export function review(id: string, options: ReviewStepOptions): ReviewStep {
  return Object.freeze({
    kind: 'review',
    id,
    ...options,
    reviewers: Object.freeze(options.reviewers.map((assignment) => Object.freeze({ ...assignment }))),
  });
}

export interface ApprovalStepOptions {
  readonly label?: string;
  readonly description?: string;
  readonly gate?: 'manual' | 'policy';
}

export function approval(
  id: string,
  prompt: string,
  options: ApprovalStepOptions = {},
): ApprovalStep {
  return Object.freeze({ kind: 'approval', id, prompt, ...options, gate: options.gate ?? 'manual' });
}

export interface DefineWorkflowInput {
  readonly id: string;
  readonly revision?: number;
  readonly name: string;
  readonly description?: string;
  readonly steps: WorkflowSequence;
  readonly budget?: WorkflowBudget;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly completion?: {
    readonly id?: string;
    readonly label?: string;
  };
}

export class WorkflowDslError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowDslError';
  }
}

interface CompiledSegment {
  readonly entry: string;
  readonly exit: string;
}

interface CompilerState {
  readonly nodes: WorkflowNode[];
  readonly edges: WorkflowEdge[];
  readonly profiles: Map<string, WorkflowProfile>;
  readonly nodeIds: Set<string>;
}

function sameProfile(left: WorkflowProfile, right: WorkflowProfile): boolean {
  return left.id === right.id
    && left.label === right.label
    && left.role === right.role
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
    && left.workspaceAccess === right.workspaceAccess
    && left.selection === right.selection
    && left.enableSubagents === right.enableSubagents
    && left.description === right.description;
}

function addProfile(state: CompilerState, profile: WorkflowProfile): void {
  const existing = state.profiles.get(profile.id);
  if (existing && !sameProfile(existing, profile)) {
    throw new WorkflowDslError(
      `Profile id ${JSON.stringify(profile.id)} has conflicting definitions. Give one variant a distinct id.`,
    );
  }
  if (!existing) state.profiles.set(profile.id, profile);
}

function addNode(state: CompilerState, node: WorkflowNode): void {
  if (state.nodeIds.has(node.id)) {
    throw new WorkflowDslError(`Duplicate generated or declared node id: ${node.id}.`);
  }
  state.nodeIds.add(node.id);
  state.nodes.push(node);
}

function normalizeLane(lane: WorkflowLane): WorkflowSequence {
  return Array.isArray(lane) ? lane : [lane as WorkflowStep];
}

function compileSequence(
  state: CompilerState,
  steps: WorkflowSequence,
  context: string,
): CompiledSegment {
  if (steps.length === 0) {
    throw new WorkflowDslError(`${context} must contain at least one step.`);
  }

  let first: CompiledSegment | undefined;
  let previous: CompiledSegment | undefined;
  for (const step of steps) {
    const current = compileStep(state, step);
    if (previous) state.edges.push({ from: previous.exit, to: current.entry });
    first ??= current;
    previous = current;
  }
  return { entry: first!.entry, exit: previous!.exit };
}

function compileParallel(state: CompilerState, step: ParallelStep): CompiledSegment {
  if (step.lanes.length < 2) {
    throw new WorkflowDslError(`Parallel step ${step.id} needs at least two lanes.`);
  }

  const dispatchId = `${step.id}--fanout`;
  const joinId = `${step.id}--join`;
  addNode(state, {
    id: dispatchId,
    kind: 'fanout',
    label: step.label ?? `Dispatch ${step.id}`,
    ...(step.description ? { description: step.description } : {}),
  });
  addNode(state, {
    id: joinId,
    kind: 'join',
    strategy: 'all',
    label: step.label ? `Join ${step.label}` : `Join ${step.id}`,
    ...(step.description ? { description: step.description } : {}),
  });

  step.lanes.forEach((lane, index) => {
    const compiled = compileSequence(state, normalizeLane(lane), `Lane ${index + 1} of ${step.id}`);
    state.edges.push({ from: dispatchId, to: compiled.entry });
    state.edges.push({ from: compiled.exit, to: joinId });
  });
  return { entry: dispatchId, exit: joinId };
}

function reviewAgents(step: ReviewStep): readonly AgentStep[] {
  const agents: AgentStep[] = [];
  let reviewerNumber = 0;
  for (const assignment of step.reviewers) {
    const count = assignment.count ?? 1;
    const cap = agentCapForProfile(assignment.profile);
    if (!Number.isInteger(count) || count < 1 || count > cap) {
      throw new WorkflowDslError(
        `Reviewer count in ${step.id} must be between one and ${cap} for ${assignment.profile.model}.`,
      );
    }
    for (let index = 0; index < count; index += 1) {
      reviewerNumber += 1;
      agents.push(agent(
        `${step.id}--reviewer-${reviewerNumber}`,
        assignment.profile,
        step.prompt,
        {
          label: assignment.label
            ? `${assignment.label} ${index + 1}`
            : `${assignment.profile.label} ${index + 1}`,
          ...(step.description ? { description: step.description } : {}),
          ...(step.maxAttempts !== undefined ? { maxAttempts: step.maxAttempts } : {}),
        },
      ));
    }
  }
  if (agents.length < 2) {
    throw new WorkflowDslError(`Review step ${step.id} needs at least two reviewers.`);
  }
  return agents;
}

function compileStep(state: CompilerState, step: WorkflowStep): CompiledSegment {
  if (step.kind === 'parallel') return compileParallel(state, step);
  if (step.kind === 'review') {
    return compileParallel(state, {
      kind: 'parallel',
      id: step.id,
      label: step.label ?? `Review council: ${step.id}`,
      ...(step.description ? { description: step.description } : {}),
      lanes: reviewAgents(step),
    });
  }
  if (step.kind === 'agent') {
    addProfile(state, step.profile);
    addNode(state, {
      id: step.id,
      kind: 'agent',
      label: step.label ?? step.id,
      ...(step.description ? { description: step.description } : {}),
      profileId: step.profile.id,
      prompt: step.prompt,
      ...(step.maxAttempts !== undefined ? { maxAttempts: step.maxAttempts } : {}),
    });
    return { entry: step.id, exit: step.id };
  }

  addNode(state, {
    id: step.id,
    kind: 'gate',
    label: step.label ?? step.id,
    ...(step.description ? { description: step.description } : {}),
    gate: step.gate,
    prompt: step.prompt,
  });
  return { entry: step.id, exit: step.id };
}

/** Compile the readable DSL into the same immutable revision used by the runner. */
export function defineWorkflow(input: DefineWorkflowInput): WorkflowRevision {
  const state: CompilerState = {
    nodes: [],
    edges: [],
    profiles: new Map(),
    nodeIds: new Set(),
  };
  const compiled = compileSequence(state, input.steps, `Workflow ${input.id}`);
  const completionId = input.completion?.id ?? 'complete';
  addNode(state, {
    id: completionId,
    kind: 'end',
    label: input.completion?.label ?? 'Complete workflow',
  });
  state.edges.push({ from: compiled.exit, to: completionId });

  const revision = defineWorkflowRevision({
    id: input.id,
    revision: input.revision ?? 1,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    profiles: [...state.profiles.values()],
    nodes: state.nodes,
    edges: state.edges,
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  const validation = validateWorkflowRevision(revision);
  if (!validation.valid) {
    throw new WorkflowDslError(
      `Compiled workflow is invalid: ${validation.issues.map((issue) => issue.message).join(' ')}`,
    );
  }
  return revision;
}

export interface HarmonyDeliveryOptions {
  readonly id?: string;
  readonly revision?: number;
  readonly name?: string;
  /** One to twenty Luna/MAX lanes. Defaults to five. */
  readonly lunaBuilders?: number;
  /** Two to five independent Opus reviews. Defaults to three. */
  readonly opusReviewers?: number;
}

/** The user's preferred Sol -> Luna/Sonnet -> Opus council -> final Sol topology. */
export function createHarmonyDeliveryWorkflow(
  options: HarmonyDeliveryOptions = {},
): WorkflowRevision {
  const lunaBuilders = options.lunaBuilders ?? 5;
  const opusReviewers = options.opusReviewers ?? 3;
  if (!Number.isInteger(lunaBuilders) || lunaBuilders < 1 || lunaBuilders > 20) {
    throw new RangeError('Harmony delivery requires between one and twenty Luna builders.');
  }
  if (!Number.isInteger(opusReviewers) || opusReviewers < 2 || opusReviewers > 5) {
    throw new RangeError('Harmony delivery requires between two and five Opus reviewers.');
  }

  const implementationLanes: WorkflowLane[] = [
    ...Array.from({ length: lunaBuilders }, (_, index) => agent(
      `luna-implementation-${index + 1}`,
      profiles.luna(),
      `Implement Luna/MAX lane ${index + 1} of ${lunaBuilders} for {{objective}}. Follow the Sol plan, coordinate through durable artifacts, and verify your bounded changes.`,
      { label: `Luna/MAX implementation ${index + 1}`, maxAttempts: 2 },
    )),
    agent(
      'sonnet-implementation',
      profiles.sonnet({
        id: 'sonnet-implementation',
        role: 'builder',
        workspaceAccess: 'workspace-write',
      }),
      'Implement a bounded complementary slice of {{objective}} from the Sol plan. Prefer integration, usability, and small fixes that strengthen the Luna lanes.',
      { label: 'Sonnet implementation', maxAttempts: 2 },
    ),
  ];

  return defineWorkflow({
    id: options.id ?? 'harmony-delivery',
    revision: options.revision,
    name: options.name ?? 'Harmony Delivery',
    description: 'Sol plans, Luna/MAX and Sonnet implement, multiple Opus agents review, and final Sol adjudicates.',
    steps: sequence(
      agent(
        'sol-plan',
        profiles.sol(),
        `Design a concrete topology and acceptance plan for {{objective}} with ${lunaBuilders} bounded Luna/MAX lanes and one Sonnet integration lane.`,
        { label: 'Sol topology and plan' },
      ),
      parallel('implementation', implementationLanes, { label: 'Parallel implementation' }),
      review('opus-council', {
        label: 'Independent Opus review council',
        prompt: 'Independently review every implementation artifact and the integrated workspace for {{objective}}. Report correctness, regressions, missing tests, and concrete fixes.',
        reviewers: [{ profile: profiles.opus(), count: opusReviewers, label: 'Opus review' }],
      }),
      agent(
        'final-sol',
        profiles.sol(),
        'Adjudicate all Opus reviews against the implementation and verification evidence. Resolve disagreements and produce the final ship recommendation for {{objective}}.',
        { label: 'Final Sol adjudication' },
      ),
      approval(
        'ship-approval',
        'Approve the integrated implementation, independent reviews, and final Sol recommendation.',
        { label: 'Ship approval' },
      ),
    ),
    budget: {
      maxModelCalls: 2 + (lunaBuilders + 1) * 2 + opusReviewers,
      maxNodeAttempts: 2 + (lunaBuilders + 1) * 2 + opusReviewers,
      maxEstimatedCostUsd: 100,
    },
    metadata: {
      template: 'harmony-delivery',
      defaultBuilder: 'luna-max',
      terraRouting: 'explicit-only',
      hiddenFallbacks: 'disabled',
    },
  });
}

const WORKFLOW_PRIMITIVES = Object.freeze([
  'sequence',
  'agent',
  'parallel',
  'review',
  'approval',
] as const);

const WORKFLOW_PROFILE_DEFAULTS = Object.freeze({
  sol: Object.freeze({ role: 'conductor', provider: 'codex', model: 'gpt-5.6-sol' }),
  luna: Object.freeze({ role: 'builder', provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' }),
  opus: Object.freeze({ role: 'reviewer', provider: 'claude', model: 'claude-opus-5', reasoningEffort: 'high', selection: 'explicit-only' }),
  sonnet: Object.freeze({ role: 'reviewer', provider: 'claude', model: 'claude-sonnet-5', reasoningEffort: 'high', selection: 'explicit-only' }),
  terra: Object.freeze({ role: 'reviewer', provider: 'codex', model: 'gpt-5.6-terra', selection: 'explicit-only' }),
});

/** Stable machine-readable capabilities for agents deciding on a topology. */
export const WORKFLOW_API_MANIFEST = Object.freeze({
  version: 2,
  primitives: WORKFLOW_PRIMITIVES,
  profiles: WORKFLOW_PROFILE_DEFAULTS,
  policy: Object.freeze({
    defaultBuilder: 'luna',
    defaultBuilderReasoningEffort: 'max',
    terraRouting: 'explicit-only',
    hiddenFallbacks: false,
    preflightRequired: true,
    defaultConcurrency: 5,
    agentCaps: WORKFLOW_AGENT_CAPS,
    subagentsDefault: false,
    fableRouting: 'disabled',
  }),
  locality: Object.freeze({
    execution: 'local-provider-cli',
    externalModelApiKeysRequired: false,
  }),
});

export function describeWorkflowApi(): typeof WORKFLOW_API_MANIFEST {
  return WORKFLOW_API_MANIFEST;
}
