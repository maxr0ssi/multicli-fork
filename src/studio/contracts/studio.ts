import type {
  AgentRole,
  AttemptUsage,
  BudgetUsage,
  NodeStatus,
  ProfileSelectionPolicy,
  RunBudgetState,
  WorkflowEdge,
  WorkflowNode,
  WorkspaceAccess,
} from '../../workflows/domain.js';
import type {
  ApprovalRecord,
  DurableRunEvent,
  RunStatus,
} from '../../persistence/runLedger.js';
import type { GoalSessionUsageProjection } from '../../workflows/goalSessionUsage.js';

export const STUDIO_CONTRACT_VERSION = 1 as const;

export type StudioActionAvailability =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface StudioRunSummary {
  readonly id: string;
  readonly workflowRevisionId: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly status: RunStatus;
  readonly objective?: string;
  readonly parentRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
  readonly nodeCounts: Readonly<Record<NodeStatus, number>>;
}

export interface StudioWorkflowSummary {
  readonly recordId: string;
  readonly workflowId: string;
  readonly logicalRevision: number;
  readonly contentHash: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: string;
  readonly nodeCount: number;
  readonly agentCount: number;
  readonly providers: readonly string[];
  readonly models: readonly string[];
  readonly workspaceAccess: readonly WorkspaceAccess[];
  readonly writerAgentCount: number;
  readonly enableSubagents: boolean;
}

export interface StudioWorkflowProfile {
  readonly id: string;
  readonly label: string;
  readonly role: AgentRole;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly workspaceAccess: WorkspaceAccess;
  readonly selection: ProfileSelectionPolicy;
  readonly enableSubagents: boolean;
  readonly description?: string;
}

export interface StudioWorkflowRevision {
  readonly recordId: string;
  readonly workflowId: string;
  readonly logicalRevision: number;
  readonly contentHash: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly profiles: Readonly<Record<string, StudioWorkflowProfile>>;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

export interface StudioAttemptLease {
  readonly state: 'active' | 'overdue';
  /** The durable row update time; heartbeat renewals advance this value. */
  readonly lastRenewedAt: string;
  readonly expiresAt: string;
}

export interface StudioNodeAttempt {
  readonly id: string;
  readonly number: number;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly outputArtifactId?: string;
  readonly error?: string;
  /** Provider-emitted values only; absent means the provider did not report usage. */
  readonly usage?: AttemptUsage;
  readonly lease?: StudioAttemptLease;
}

export interface StudioNodeExecution {
  readonly nodeId: string;
  readonly status: NodeStatus | 'queued';
  readonly activeAttemptId?: string;
  readonly gateDecision?: 'approved' | 'rejected';
  readonly attempts: readonly StudioNodeAttempt[];
  readonly artifactIds: readonly string[];
  readonly approvalIds: readonly string[];
}

export interface StudioArtifactSummary {
  readonly id: string;
  readonly runId: string;
  readonly nodeAttemptId?: string;
  readonly name: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly byteLength?: number;
  readonly preview: StudioActionAvailability;
}

export interface StudioArtifactPreview {
  readonly artifact: StudioArtifactSummary;
  readonly text: string;
  readonly bytesRead: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export interface StudioWorkflowGateContext {
  readonly kind: 'workflow-gate';
  readonly nodeId: string;
  readonly prompt: string;
  readonly artifactIds: readonly string[];
  readonly harnessInvocationIds: readonly string[];
}

export interface StudioUnknownApprovalContext {
  readonly kind: 'unknown';
  readonly payload: unknown;
}

export interface StudioApproval {
  readonly id: string;
  readonly runId: string;
  readonly nodeAttemptId?: string;
  readonly actionHash: string;
  readonly risk: string;
  readonly status: ApprovalRecord['status'];
  readonly requestedAt: string;
  readonly resolvedAt?: string;
  readonly expiresAt?: string;
  readonly decisionBy?: string;
  readonly context: StudioWorkflowGateContext | StudioUnknownApprovalContext;
  readonly resolve: StudioActionAvailability;
}

export interface StudioHarnessEvidence {
  readonly gateId?: string;
  readonly invocationId?: string;
  readonly outcome: string;
  readonly findingCount?: number;
  readonly checks: readonly unknown[];
  readonly completedAt: string;
  readonly sequence: number;
}

export interface StudioGoalSessionSummary {
  readonly id: string;
  readonly runId?: string;
  readonly workflowRevisionId?: string;
  readonly profileId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly workspaceAccess: string;
  readonly enableSubagents: boolean;
  readonly status: 'active' | 'blocked' | 'closed';
  readonly turnState: 'idle' | 'running';
  readonly turnCount: number;
  readonly updatedAt: string;
  /** Provider usage for permanent-session calls only; workflow attempts are excluded. */
  readonly providerUsage: GoalSessionUsageProjection;
  readonly turnLease?: {
    readonly state: 'active' | 'overdue';
    readonly expiresAt: string;
  };
  readonly allowedActions: {
    /** A new durable provider turn; this is not in-flight steering. */
    readonly sendInstruction: StudioActionAvailability;
    readonly close: StudioActionAvailability;
  };
}

export interface StudioRunView {
  readonly schemaVersion: typeof STUDIO_CONTRACT_VERSION;
  readonly serverTime: string;
  readonly run: StudioRunSummary & {
    readonly input: unknown;
    readonly allowedActions: {
      readonly pause: StudioActionAvailability;
      readonly resume: StudioActionAvailability;
      readonly cancel: StudioActionAvailability;
      readonly openGoalSession: StudioActionAvailability;
    };
  };
  readonly workflow: StudioWorkflowRevision;
  readonly execution: {
    readonly status: RunStatus;
    readonly failureReason?: string;
    readonly budget: RunBudgetState;
    readonly nodes: Readonly<Record<string, StudioNodeExecution>>;
    readonly integrity: {
      readonly state: 'ok' | 'degraded';
      readonly issues: readonly string[];
    };
  };
  readonly events: readonly DurableRunEvent[];
  readonly artifacts: readonly StudioArtifactSummary[];
  readonly approvals: readonly StudioApproval[];
  readonly harness: readonly StudioHarnessEvidence[];
  readonly goalSessions: readonly StudioGoalSessionSummary[];
}

export interface StudioBootstrap {
  readonly schemaVersion: typeof STUDIO_CONTRACT_VERSION;
  readonly serverTime: string;
  readonly workspace: string;
  readonly runs: readonly StudioRunSummary[];
  readonly workflows: readonly StudioWorkflowSummary[];
  readonly pendingApprovalCount: number;
  readonly capabilities: {
    readonly goalSessions: boolean;
    readonly inFlightSteering: false;
    readonly artifactPreview: boolean;
  };
}

/** Useful to clients that render budget totals without depending on reducer internals. */
export type StudioBudgetUsage = BudgetUsage;
