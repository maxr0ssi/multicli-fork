import { ApprovalArtifactStore } from './approvalArtifactStore.js';
import { GoalSessionLedgerStore } from './goalSessionStore.js';
import { LedgerCore } from './ledgerCore.js';
import { openLedgerDatabase } from './ledgerSchema.js';
import { NodeAttemptStore } from './nodeAttemptStore.js';
import type {
  AppendEventOptions,
  ApprovalRecord,
  ArtifactRecord,
  BlockGoalSessionTurnInput,
  ClaimWorkflowRunnerAuthorityInput,
  ClaimGoalSessionTurnInput,
  ClaimNodeAttemptInput,
  CompleteGoalSessionTurnInput,
  CompleteNodeAttemptInput,
  CreateWorkflowDraftInput,
  CreateGoalSessionInput,
  CreateRunInput,
  DurableNodeAttemptRecord,
  DurableRunEvent,
  DurableRunRecord,
  FailGoalSessionTurnInput,
  GoalSessionArtifactRecord,
  GoalSessionRecord,
  RecordArtifactInput,
  RecordGoalSessionArtifactInput,
  RenewGoalSessionTurnLeaseInput,
  RecordWorkflowRevisionInput,
  PublishedAndStartedWorkflowDraft,
  PublishedWorkflowDraft,
  PublishAndStartWorkflowDraftInput,
  PublishWorkflowDraftInput,
  RenewNodeAttemptLeaseInput,
  RenewWorkflowRunnerAuthorityInput,
  ReleaseWorkflowRunnerAuthorityInput,
  RequestApprovalInput,
  ResolveApprovalInput,
  RunLedger,
  ScheduleNodeAttemptInput,
  StartedRunRecord,
  WorkflowRevisionRecord,
  WorkflowRunnerAuthorityRecord,
  UpdateWorkflowDraftInput,
  WorkflowDraftRecord,
} from './runLedger.types.js';
import { WorkflowRunStore } from './workflowRunStore.js';
import { WorkflowDraftStore } from './workflowDraftStore.js';
import { WorkflowRunnerAuthorityStore } from './workflowRunnerAuthorityStore.js';

export {
  assertWorkflowDraftDefinitionLimits,
  WorkflowDraftValidationError,
  WorkflowDraftVersionConflictError,
} from './workflowDraftStore.js';

export * from './runLedger.types.js';

/**
 * Durable SQLite facade. Domain operations live in focused stores while this
 * class preserves the package's original import path and public API.
 */
export class SqliteRunLedger implements RunLedger {
  readonly databasePath: string;
  readonly #core: LedgerCore;
  readonly #runs: WorkflowRunStore;
  readonly #drafts: WorkflowDraftStore;
  readonly #attempts: NodeAttemptStore;
  readonly #goals: GoalSessionLedgerStore;
  readonly #approvals: ApprovalArtifactStore;
  readonly #runnerAuthorities: WorkflowRunnerAuthorityStore;
  #closed = false;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.#core = new LedgerCore(openLedgerDatabase(databasePath));
    this.#runs = new WorkflowRunStore(this.#core);
    this.#drafts = new WorkflowDraftStore(this.#core, this.#runs);
    this.#attempts = new NodeAttemptStore(this.#core);
    this.#goals = new GoalSessionLedgerStore(this.#core);
    this.#approvals = new ApprovalArtifactStore(this.#core);
    this.#runnerAuthorities = new WorkflowRunnerAuthorityStore(this.#core);
  }

  createWorkflowDraft(input: CreateWorkflowDraftInput): WorkflowDraftRecord {
    return this.#drafts.create(input);
  }

  getWorkflowDraft(id: string): WorkflowDraftRecord | undefined {
    return this.#drafts.get(id);
  }

  listWorkflowDrafts(workflowId?: string): WorkflowDraftRecord[] {
    return this.#drafts.list(workflowId);
  }

  updateWorkflowDraft(input: UpdateWorkflowDraftInput): WorkflowDraftRecord {
    return this.#drafts.update(input);
  }

  publishWorkflowDraft(input: PublishWorkflowDraftInput): PublishedWorkflowDraft {
    return this.#drafts.publish(input);
  }

  publishAndStartWorkflowDraft(
    input: PublishAndStartWorkflowDraftInput,
  ): PublishedAndStartedWorkflowDraft {
    return this.#drafts.publishAndStart(input);
  }

  recordWorkflowRevision(input: RecordWorkflowRevisionInput): WorkflowRevisionRecord {
    return this.#runs.recordWorkflowRevision(input);
  }

  getWorkflowRevision(id: string): WorkflowRevisionRecord | undefined {
    return this.#runs.getWorkflowRevision(id);
  }

  listWorkflowRevisions(workflowId?: string): WorkflowRevisionRecord[] {
    return this.#runs.listWorkflowRevisions(workflowId);
  }

  createRun(input: CreateRunInput): DurableRunRecord {
    return this.#runs.createRun(input);
  }

  createStartedRun(input: CreateRunInput, payload?: unknown): StartedRunRecord {
    return this.#runs.createStartedRun(input, payload);
  }

  getRun(id: string): DurableRunRecord | undefined {
    return this.#runs.getRun(id);
  }

  listRuns(limit?: number): DurableRunRecord[] {
    return this.#runs.listRuns(limit);
  }

  appendEvent(
    runId: string,
    type: string,
    payload?: unknown,
    options?: AppendEventOptions,
  ): DurableRunEvent {
    return this.#runs.appendEvent(runId, type, payload, options);
  }

  listEvents(runId: string, afterSequence?: number, limit?: number): DurableRunEvent[] {
    return this.#runs.listEvents(runId, afterSequence, limit);
  }

  listAllEvents(runId: string, afterSequence?: number): DurableRunEvent[] {
    return this.#runs.listAllEvents(runId, afterSequence);
  }

  getWorkflowRunnerAuthority(workspace: string): WorkflowRunnerAuthorityRecord | undefined {
    return this.#runnerAuthorities.get(workspace);
  }

  claimWorkflowRunnerAuthority(
    input: ClaimWorkflowRunnerAuthorityInput,
  ): WorkflowRunnerAuthorityRecord | undefined {
    return this.#runnerAuthorities.claim(input);
  }

  renewWorkflowRunnerAuthority(
    input: RenewWorkflowRunnerAuthorityInput,
  ): WorkflowRunnerAuthorityRecord {
    return this.#runnerAuthorities.renew(input);
  }

  releaseWorkflowRunnerAuthority(input: ReleaseWorkflowRunnerAuthorityInput): boolean {
    return this.#runnerAuthorities.release(input);
  }

  scheduleNodeAttempt(input: ScheduleNodeAttemptInput): DurableNodeAttemptRecord {
    return this.#attempts.scheduleNodeAttempt(input);
  }

  claimNodeAttempt(input: ClaimNodeAttemptInput): DurableNodeAttemptRecord | undefined {
    return this.#attempts.claimNodeAttempt(input);
  }

  renewNodeAttemptLease(input: RenewNodeAttemptLeaseInput): DurableNodeAttemptRecord {
    return this.#attempts.renewNodeAttemptLease(input);
  }

  completeNodeAttempt(input: CompleteNodeAttemptInput): DurableNodeAttemptRecord {
    return this.#attempts.completeNodeAttempt(input);
  }

  getNodeAttempt(id: string): DurableNodeAttemptRecord | undefined {
    return this.#attempts.getNodeAttempt(id);
  }

  listNodeAttempts(runId: string): DurableNodeAttemptRecord[] {
    return this.#attempts.listNodeAttempts(runId);
  }

  recoverExpiredNodeAttempts(now?: string, workspace?: string): DurableNodeAttemptRecord[] {
    return this.#attempts.recoverExpiredNodeAttempts(now, workspace);
  }

  createGoalSession(input: CreateGoalSessionInput): GoalSessionRecord {
    return this.#goals.createGoalSession(input);
  }

  getGoalSession(id: string): GoalSessionRecord | undefined {
    return this.#goals.getGoalSession(id);
  }

  listGoalSessions(runId?: string, limit?: number): GoalSessionRecord[] {
    return this.#goals.listGoalSessions(runId, limit);
  }

  listGoalSessionArtifacts(sessionId: string): GoalSessionArtifactRecord[] {
    return this.#goals.listGoalSessionArtifacts(sessionId);
  }

  claimGoalSessionTurn(input: ClaimGoalSessionTurnInput): GoalSessionRecord | undefined {
    return this.#goals.claimGoalSessionTurn(input);
  }

  renewGoalSessionTurnLease(input: RenewGoalSessionTurnLeaseInput): GoalSessionRecord {
    return this.#goals.renewGoalSessionTurnLease(input);
  }

  recordGoalSessionArtifact(input: RecordGoalSessionArtifactInput): GoalSessionArtifactRecord {
    return this.#goals.recordGoalSessionArtifact(input);
  }

  completeGoalSessionTurn(input: CompleteGoalSessionTurnInput): GoalSessionRecord {
    return this.#goals.completeGoalSessionTurn(input);
  }

  failGoalSessionTurn(input: FailGoalSessionTurnInput): GoalSessionRecord {
    return this.#goals.failGoalSessionTurn(input);
  }

  blockGoalSessionTurn(input: BlockGoalSessionTurnInput): GoalSessionRecord {
    return this.#goals.blockGoalSessionTurn(input);
  }

  closeGoalSession(id: string, now?: string): GoalSessionRecord {
    return this.#goals.closeGoalSession(id, now);
  }

  requestApproval(input: RequestApprovalInput): ApprovalRecord {
    return this.#approvals.requestApproval(input);
  }

  resolveApproval(input: ResolveApprovalInput): ApprovalRecord {
    return this.#approvals.resolveApproval(input);
  }

  getApproval(id: string): ApprovalRecord | undefined {
    return this.#approvals.getApproval(id);
  }

  listApprovals(runId?: string, limit?: number): ApprovalRecord[] {
    return this.#approvals.listApprovals(runId, limit);
  }

  listPendingApprovals(runId?: string): ApprovalRecord[] {
    return this.#approvals.listPendingApprovals(runId);
  }

  recordArtifact(input: RecordArtifactInput): ArtifactRecord {
    return this.#approvals.recordArtifact(input);
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    return this.#approvals.listArtifacts(runId);
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    return this.#approvals.getArtifact(id);
  }

  close(): void {
    if (this.#closed) return;
    this.#core.db.close();
    this.#closed = true;
  }
}

export function createInMemoryRunLedger(): SqliteRunLedger {
  return new SqliteRunLedger(':memory:');
}
