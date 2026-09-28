import type {
  ClaimWorkflowRunnerAuthorityInput,
  ReleaseWorkflowRunnerAuthorityInput,
  RenewWorkflowRunnerAuthorityInput,
  WorkflowRunnerAuthorityRecord,
} from './runAuthority.types.js';
import type {
  CreateWorkflowDraftInput,
  PublishAndStartWorkflowDraftInput,
  PublishWorkflowDraftInput,
  UpdateWorkflowDraftInput,
  WorkflowDraftRecord,
} from './workflowDraft.types.js';

export type {
  ClaimWorkflowRunnerAuthorityInput,
  ReleaseWorkflowRunnerAuthorityInput,
  RenewWorkflowRunnerAuthorityInput,
  WorkflowRunnerAuthorityRecord,
} from './runAuthority.types.js';
export type {
  CreateWorkflowDraftInput,
  PublishAndStartWorkflowDraftInput,
  PublishWorkflowDraftInput,
  UpdateWorkflowDraftInput,
  WorkflowDraftRecord,
} from './workflowDraft.types.js';

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export interface WorkflowRevisionRecord {
  id: string;
  workflowId: string;
  contentHash: string;
  definition: unknown;
  createdAt: string;
}

export interface PublishedWorkflowDraft {
  draft: WorkflowDraftRecord;
  workflowRevision: WorkflowRevisionRecord;
}

export interface DurableRunRecord {
  id: string;
  workflowRevisionId: string;
  /** Missing only on rows created before workspace pinning was introduced. */
  workspace?: string;
  status: RunStatus;
  input: unknown;
  createdAt: string;
  updatedAt: string;
  lastSequence: number;
  parentRunId?: string;
}

export interface DurableRunEvent {
  runId: string;
  sequence: number;
  timestamp: string;
  type: string;
  payload: unknown;
  idempotencyKey?: string;
}

/** Provider-emitted usage attached to a completed node event; absent means unknown. */
export interface NodeAttemptUsageRecord {
  estimatedCostUsd?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface StartedRunRecord {
  run: DurableRunRecord;
  event: DurableRunEvent;
}

export interface PublishedAndStartedWorkflowDraft extends PublishedWorkflowDraft {
  startedRun: StartedRunRecord;
  runCreated: boolean;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  nodeAttemptId?: string;
  actionHash: string;
  risk: string;
  payload: unknown;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  requestedAt: string;
  resolvedAt?: string;
  expiresAt?: string;
  decisionBy?: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  nodeAttemptId?: string;
  contentHash: string;
  mediaType: string;
  name: string;
  location: string;
  metadata: unknown;
  createdAt: string;
}

export type GoalSessionStatus = 'active' | 'blocked' | 'closed';
export type GoalSessionTurnState = 'idle' | 'running';
export type GoalSessionArtifactKind = 'goal' | 'instruction' | 'reply' | 'usage';

export interface GoalSessionRecord {
  id: string;
  runId?: string;
  workflowRevisionId?: string;
  profileId: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  workspaceAccess: string;
  selection: 'default' | 'explicit-only';
  enableSubagents: boolean;
  cwd: string;
  nativeSessionId?: string;
  status: GoalSessionStatus;
  turnState: GoalSessionTurnState;
  turnCount: number;
  goalArtifactId: string;
  lastInstructionArtifactId?: string;
  lastReplyArtifactId?: string;
  turnOwner?: string;
  turnLeaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface GoalSessionArtifactRecord {
  id: string;
  sessionId: string;
  turnNumber?: number;
  kind: GoalSessionArtifactKind;
  contentHash: string;
  mediaType: string;
  name: string;
  location: string;
  metadata: unknown;
  createdAt: string;
}

export interface GoalSessionStore {
  createGoalSession(input: CreateGoalSessionInput): GoalSessionRecord;
  getGoalSession(id: string): GoalSessionRecord | undefined;
  listGoalSessions(runId?: string, limit?: number): GoalSessionRecord[];
  listGoalSessionArtifacts(sessionId: string): GoalSessionArtifactRecord[];
  claimGoalSessionTurn(input: ClaimGoalSessionTurnInput): GoalSessionRecord | undefined;
  renewGoalSessionTurnLease(input: RenewGoalSessionTurnLeaseInput): GoalSessionRecord;
  recordGoalSessionArtifact(input: RecordGoalSessionArtifactInput): GoalSessionArtifactRecord;
  completeGoalSessionTurn(input: CompleteGoalSessionTurnInput): GoalSessionRecord;
  failGoalSessionTurn(input: FailGoalSessionTurnInput): GoalSessionRecord;
  blockGoalSessionTurn(input: BlockGoalSessionTurnInput): GoalSessionRecord;
  closeGoalSession(id: string, now?: string): GoalSessionRecord;
}

export interface DurableNodeAttemptRecord {
  id: string;
  runId: string;
  nodeId: string;
  attemptNumber: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  idempotencyKey: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  finishedAt?: string;
  outputArtifactId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppendEventOptions {
  expectedSequence?: number;
  idempotencyKey?: string;
  timestamp?: string;
}

export interface CreateGoalSessionInput {
  id?: string;
  runId?: string;
  workflowRevisionId?: string;
  profileId: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  workspaceAccess: string;
  selection: 'default' | 'explicit-only';
  enableSubagents: boolean;
  cwd: string;
  goalArtifact: Omit<GoalSessionArtifactRecord, 'id' | 'sessionId' | 'createdAt' | 'kind'> & {
    id?: string;
  };
  createdAt?: string;
}

export interface ClaimGoalSessionTurnInput {
  id: string;
  owner: string;
  leaseMs: number;
  now?: string;
}

export interface RenewGoalSessionTurnLeaseInput {
  id: string;
  owner: string;
  leaseMs: number;
  now?: string;
}

export interface RecordGoalSessionArtifactInput {
  id?: string;
  sessionId: string;
  turnNumber: number;
  kind: 'instruction' | 'reply' | 'usage';
  contentHash: string;
  mediaType: string;
  name: string;
  location: string;
  metadata?: unknown;
  createdAt?: string;
}

export interface CompleteGoalSessionTurnInput {
  id: string;
  owner: string;
  nativeSessionId: string;
  instructionArtifactId: string;
  replyArtifactId: string;
  now?: string;
}

export interface FailGoalSessionTurnInput {
  id: string;
  owner: string;
  reason: 'provider_execution_failed' | 'native_session_missing' | 'native_session_changed';
  now?: string;
}

export interface BlockGoalSessionTurnInput {
  id: string;
  owner: string;
  nativeSessionId?: string;
  reason: 'native_session_missing' | 'native_session_changed' | 'post_provider_persistence_failed';
  now?: string;
}

export interface RunLedger extends GoalSessionStore {
  createWorkflowDraft(input: CreateWorkflowDraftInput): WorkflowDraftRecord;
  getWorkflowDraft(id: string): WorkflowDraftRecord | undefined;
  listWorkflowDrafts(workflowId?: string): WorkflowDraftRecord[];
  updateWorkflowDraft(input: UpdateWorkflowDraftInput): WorkflowDraftRecord;
  publishWorkflowDraft(input: PublishWorkflowDraftInput): PublishedWorkflowDraft;
  publishAndStartWorkflowDraft(
    input: PublishAndStartWorkflowDraftInput,
  ): PublishedAndStartedWorkflowDraft;
  recordWorkflowRevision(input: RecordWorkflowRevisionInput): WorkflowRevisionRecord;
  getWorkflowRevision(id: string): WorkflowRevisionRecord | undefined;
  listWorkflowRevisions(workflowId?: string): WorkflowRevisionRecord[];
  createRun(input: CreateRunInput): DurableRunRecord;
  createStartedRun(input: CreateRunInput, payload?: unknown): StartedRunRecord;
  getRun(id: string): DurableRunRecord | undefined;
  listRuns(limit?: number): DurableRunRecord[];
  appendEvent(
    runId: string,
    type: string,
    payload?: unknown,
    options?: AppendEventOptions,
  ): DurableRunEvent;
  listEvents(runId: string, afterSequence?: number, limit?: number): DurableRunEvent[];
  listAllEvents(runId: string, afterSequence?: number): DurableRunEvent[];
  getWorkflowRunnerAuthority(workspace: string): WorkflowRunnerAuthorityRecord | undefined;
  claimWorkflowRunnerAuthority(
    input: ClaimWorkflowRunnerAuthorityInput,
  ): WorkflowRunnerAuthorityRecord | undefined;
  renewWorkflowRunnerAuthority(
    input: RenewWorkflowRunnerAuthorityInput,
  ): WorkflowRunnerAuthorityRecord;
  releaseWorkflowRunnerAuthority(input: ReleaseWorkflowRunnerAuthorityInput): boolean;
  scheduleNodeAttempt(input: ScheduleNodeAttemptInput): DurableNodeAttemptRecord;
  claimNodeAttempt(input: ClaimNodeAttemptInput): DurableNodeAttemptRecord | undefined;
  renewNodeAttemptLease(input: RenewNodeAttemptLeaseInput): DurableNodeAttemptRecord;
  completeNodeAttempt(input: CompleteNodeAttemptInput): DurableNodeAttemptRecord;
  getNodeAttempt(id: string): DurableNodeAttemptRecord | undefined;
  listNodeAttempts(runId: string): DurableNodeAttemptRecord[];
  recoverExpiredNodeAttempts(now?: string, workspace?: string): DurableNodeAttemptRecord[];
  requestApproval(input: RequestApprovalInput): ApprovalRecord;
  resolveApproval(input: ResolveApprovalInput): ApprovalRecord;
  getApproval(id: string): ApprovalRecord | undefined;
  listApprovals(runId?: string, limit?: number): ApprovalRecord[];
  listPendingApprovals(runId?: string): ApprovalRecord[];
  recordArtifact(input: RecordArtifactInput): ArtifactRecord;
  listArtifacts(runId: string): ArtifactRecord[];
  getArtifact(id: string): ArtifactRecord | undefined;
  close(): void;
}

export interface RecordWorkflowRevisionInput {
  id?: string;
  workflowId: string;
  definition: unknown;
  createdAt?: string;
}

export interface CreateRunInput {
  id?: string;
  workflowRevisionId: string;
  workspace: string;
  input?: unknown;
  parentRunId?: string;
  createdAt?: string;
}

export interface ScheduleNodeAttemptInput {
  id?: string;
  runId: string;
  nodeId: string;
  attemptNumber?: number;
  idempotencyKey: string;
}

export interface ClaimNodeAttemptInput {
  id: string;
  workerId: string;
  leaseMs: number;
  now?: string;
}

export interface RenewNodeAttemptLeaseInput {
  id: string;
  workerId: string;
  leaseMs: number;
  now?: string;
}

export interface CompleteNodeAttemptInput {
  id: string;
  workerId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  outputArtifactId?: string;
  error?: string;
  retryable?: boolean;
  usage?: NodeAttemptUsageRecord;
  now?: string;
}

export interface RequestApprovalInput {
  id?: string;
  runId: string;
  nodeAttemptId?: string;
  actionHash: string;
  risk: string;
  payload?: unknown;
  expiresAt?: string;
}

export interface ResolveApprovalInput {
  id: string;
  decision: 'approved' | 'denied';
  decisionBy: string;
  actionHash: string;
}

export interface RecordArtifactInput {
  id?: string;
  runId: string;
  nodeAttemptId?: string;
  contentHash: string;
  mediaType: string;
  name: string;
  location: string;
  metadata?: unknown;
}
