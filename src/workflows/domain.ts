/**
 * Provider-neutral workflow vocabulary.
 *
 * This module deliberately models a workflow without importing an MCP server,
 * a CLI, or a particular vendor. Provider adapters resolve these profiles when
 * a run is actually scheduled.
 */

export type ProfileSelectionPolicy = 'default' | 'explicit-only';

export type WorkspaceAccess =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

export type AgentRole =
  | 'builder'
  | 'conductor'
  | 'reviewer'
  | 'researcher'
  | 'custom';

/** A reusable, provider-neutral execution profile. */
export interface WorkflowProfile {
  readonly id: string;
  readonly label: string;
  readonly role: AgentRole;
  /** Adapter id, not an executable name. For example: "codex" or "claude". */
  readonly provider: string;
  /** The adapter's model identifier. */
  readonly model: string;
  /** Provider-specific reasoning setting, kept opaque to the domain. */
  readonly reasoningEffort?: string;
  readonly workspaceAccess: WorkspaceAccess;
  /** Explicit-only profiles may never be selected by an automatic default. */
  readonly selection: ProfileSelectionPolicy;
  /** Provider-native nested agents are disabled unless this is explicitly true. */
  readonly enableSubagents?: boolean;
  readonly description?: string;
}

export interface WorkflowBudget {
  /** Number of model invocations the run may start. */
  readonly maxModelCalls?: number;
  /** Number of started agent attempts, including retries. */
  readonly maxNodeAttempts?: number;
  /** Caller-supplied estimate or actual spend, in USD. */
  readonly maxEstimatedCostUsd?: number;
  /** Provider-reported normalized input, checked after a completed turn. */
  readonly maxInputTokens?: number;
  /** Provider-reported output, checked after a completed turn. */
  readonly maxOutputTokens?: number;
}

export interface BudgetUsage {
  readonly modelCalls: number;
  readonly nodeAttempts: number;
  /** Attempts whose provider emitted at least one usage field. */
  readonly usageReports: number;
  readonly estimatedCostUsd: number;
  /** Normalized total input; cached categories are breakdowns, not additions. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

/** Runtime usage reported after an attempt. Invocation counts are reducer-owned. */
export interface AttemptUsage {
  readonly estimatedCostUsd?: number;
  /** Normalized total input; cached categories are breakdowns, not additions. */
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
}

export interface WorkflowNodeBase {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface AgentNode extends WorkflowNodeBase {
  readonly kind: 'agent';
  readonly profileId: string;
  readonly prompt: string;
  /** Includes the first attempt. Defaults to one. */
  readonly maxAttempts?: number;
}

/** Opens every outgoing branch once its predecessors are complete. */
export interface FanoutNode extends WorkflowNodeBase {
  readonly kind: 'fanout';
}

/** Waits for every incoming branch before its successors can continue. */
export interface JoinNode extends WorkflowNodeBase {
  readonly kind: 'join';
  readonly strategy: 'all';
}

/** A human or policy approval boundary. */
export interface GateNode extends WorkflowNodeBase {
  readonly kind: 'gate';
  readonly gate: 'manual' | 'policy';
  readonly prompt: string;
}

/** Terminal node for a revision. */
export interface EndNode extends WorkflowNodeBase {
  readonly kind: 'end';
}

export type WorkflowNode = AgentNode | FanoutNode | JoinNode | GateNode | EndNode;

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
}

export interface WorkflowRevisionInput {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly description?: string;
  readonly profiles: readonly WorkflowProfile[];
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly budget?: WorkflowBudget;
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * A self-contained, immutable version of a workflow. Existing runs always use
 * the revision they started with; editing means making a new revision.
 */
export type WorkflowRevision = Readonly<WorkflowRevisionInput>;

export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted';

export type NodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting_for_gate'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted';

export type AttemptStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted';

export interface ResolvedProfile {
  readonly profileId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly workspaceAccess: WorkspaceAccess;
  readonly selection: ProfileSelectionPolicy;
  readonly enableSubagents: boolean;
}

/** One immutable record of a provider invocation for an agent node. */
export interface NodeAttempt {
  readonly id: string;
  readonly number: number;
  readonly status: AttemptStatus;
  readonly profile: ResolvedProfile;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly usage: AttemptUsage;
  readonly summary?: string;
  readonly error?: string;
}

export interface NodeRunState {
  readonly nodeId: string;
  readonly status: NodeStatus;
  readonly attempts: readonly NodeAttempt[];
  readonly activeAttemptId?: string;
  readonly gateDecision?: 'approved' | 'rejected';
}

export interface RunBudgetState {
  readonly limits: WorkflowBudget;
  readonly usage: BudgetUsage;
}

export interface RunRecord {
  readonly id: string;
  readonly workflow: {
    readonly id: string;
    readonly revision: number;
  };
  readonly status: RunStatus;
  readonly nodeStates: Readonly<Record<string, NodeRunState>>;
  readonly budget: RunBudgetState;
  readonly events: readonly RunEvent[];
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failureReason?: string;
}

export interface RunEventBase {
  readonly id: string;
  readonly at: string;
}

export interface RunStartedEvent extends RunEventBase {
  readonly type: 'run.started';
}

export interface NodeStartedEvent extends RunEventBase {
  readonly type: 'node.started';
  readonly nodeId: string;
  readonly attemptId: string;
}

export interface NodeSucceededEvent extends RunEventBase {
  readonly type: 'node.succeeded';
  readonly nodeId: string;
  readonly attemptId: string;
  readonly usage?: AttemptUsage;
  readonly summary?: string;
}

export interface NodeFailedEvent extends RunEventBase {
  readonly type: 'node.failed';
  readonly nodeId: string;
  readonly attemptId: string;
  readonly usage?: AttemptUsage;
  readonly error: string;
  /** Defaults to true when the node has attempts remaining. */
  readonly retryable?: boolean;
}

export interface GateResolvedEvent extends RunEventBase {
  readonly type: 'gate.resolved';
  readonly nodeId: string;
  readonly decision: 'approved' | 'rejected';
  readonly note?: string;
}

export interface RunCancelledEvent extends RunEventBase {
  readonly type: 'run.cancelled';
  readonly reason?: string;
}

export interface RunBudgetExhaustedEvent extends RunEventBase {
  readonly type: 'run.budget_exhausted';
  readonly reason: string;
}

/** The append-only input vocabulary accepted by the pure reducer. */
export type RunEvent =
  | RunStartedEvent
  | NodeStartedEvent
  | NodeSucceededEvent
  | NodeFailedEvent
  | GateResolvedEvent
  | RunCancelledEvent
  | RunBudgetExhaustedEvent;

export interface CreateInitialRunOptions {
  readonly id: string;
  readonly createdAt: string;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry));
  }

  if (value !== null && typeof value === 'object') {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = cloneValue(entry);
    }
    return clone;
  }

  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/** Clone before freezing so callers retain ownership of their input object. */
export function defineWorkflowProfile(profile: WorkflowProfile): WorkflowProfile {
  return deepFreeze(cloneValue(profile) as WorkflowProfile);
}

/** Clone before freezing to make a revision safe to retain in run history. */
export function defineWorkflowRevision(input: WorkflowRevisionInput): WorkflowRevision {
  return deepFreeze(cloneValue(input) as WorkflowRevision);
}

export function emptyBudgetUsage(): BudgetUsage {
  return {
    modelCalls: 0,
    nodeAttempts: 0,
    usageReports: 0,
    estimatedCostUsd: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

export function resolveProfile(profile: WorkflowProfile): ResolvedProfile {
  return {
    profileId: profile.id,
    provider: profile.provider,
    model: profile.model,
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    workspaceAccess: profile.workspaceAccess,
    selection: profile.selection,
    enableSubagents: profile.enableSubagents ?? false,
  };
}
