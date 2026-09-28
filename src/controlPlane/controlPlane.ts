import { EventEmitter } from 'node:events';

import type {
  ApprovalRecord,
  ArtifactRecord,
  DurableRunEvent,
  DurableRunRecord,
  DurableNodeAttemptRecord,
  PublishAndStartWorkflowDraftInput,
  RunLedger,
  WorkflowRevisionRecord,
} from '../persistence/runLedger.js';
import { WorkflowDraftVersionConflictError } from '../persistence/runLedger.js';
import {
  publishedWorkflowDraftView,
  workflowDraftView,
  type PublishedWorkflowDraftView,
  type WorkflowDraftSummary,
  type WorkflowDraftUpdateResult,
  type WorkflowDraftView,
  workflowDraftSummary,
} from './workflowDrafts.js';

export interface RunSnapshot {
  run: DurableRunRecord;
  workflowRevision: WorkflowRevisionRecord;
  events: DurableRunEvent[];
  approvals: ApprovalRecord[];
  artifacts: ArtifactRecord[];
}

export type RunEventListener = (event: DurableRunEvent) => void;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export class LocalControlPlane {
  readonly ledger: RunLedger;
  readonly #events = new EventEmitter();

  constructor(ledger: RunLedger) {
    this.ledger = ledger;
    this.#events.setMaxListeners(0);
  }

  publishWorkflow(input: {
    id?: string;
    workflowId: string;
    definition: unknown;
  }): WorkflowRevisionRecord {
    return this.ledger.recordWorkflowRevision(input);
  }

  createWorkflowDraft(input: {
    id?: string;
    workflowId?: string;
    definition?: unknown;
    proposedRunInput?: unknown;
    sourceRevisionId?: string;
  }): WorkflowDraftView {
    const source = input.sourceRevisionId
      ? this.ledger.getWorkflowRevision(input.sourceRevisionId)
      : undefined;
    if (input.sourceRevisionId && !source) {
      throw new Error(`Unknown workflow revision: ${input.sourceRevisionId}`);
    }
    if (source && input.workflowId && input.workflowId !== source.workflowId) {
      throw new Error('workflowId must match the source workflow revision');
    }
    const workflowId = input.workflowId ?? source?.workflowId;
    if (!workflowId) throw new Error('workflowId must be a non-empty string');
    const definition = input.definition ?? source?.definition;
    if (definition === undefined) throw new Error('definition is required');
    return workflowDraftView(this.ledger.createWorkflowDraft({
      ...(input.id ? { id: input.id } : {}),
      workflowId,
      definition,
      ...(Object.hasOwn(input, 'proposedRunInput')
        ? { proposedRunInput: input.proposedRunInput } : {}),
      ...(source ? { baseRevisionId: source.id } : {}),
    }));
  }

  getWorkflowDraft(id: string, expectedVersion?: number): WorkflowDraftView {
    const draft = this.ledger.getWorkflowDraft(id);
    if (!draft) throw new Error(`Unknown workflow draft: ${id}`);
    if (expectedVersion !== undefined && draft.version !== expectedVersion) {
      throw new WorkflowDraftVersionConflictError(id, expectedVersion, draft.version);
    }
    return workflowDraftView(draft);
  }

  listWorkflowDrafts(workflowId?: string): WorkflowDraftSummary[] {
    return this.ledger.listWorkflowDrafts(workflowId).map(workflowDraftSummary);
  }

  updateWorkflowDraft(input: {
    id: string;
    expectedVersion: number;
    definition: unknown;
    proposedRunInput?: unknown;
  }): WorkflowDraftUpdateResult {
    const current = this.getWorkflowDraft(input.id, input.expectedVersion);
    if (current.publishedRevisionId) {
      return {
        draft: workflowDraftView(this.ledger.createWorkflowDraft({
          workflowId: current.workflowId,
          definition: input.definition,
          ...(Object.hasOwn(input, 'proposedRunInput')
            ? { proposedRunInput: input.proposedRunInput }
            : Object.hasOwn(current, 'proposedRunInput')
              ? { proposedRunInput: current.proposedRunInput }
              : {}),
          baseRevisionId: current.publishedRevisionId,
        })),
        forkedFromDraftId: current.id,
      };
    }
    return {
      draft: workflowDraftView(this.ledger.updateWorkflowDraft({
        ...input,
        ...(Object.hasOwn(input, 'proposedRunInput')
          ? { proposedRunInput: input.proposedRunInput } : {}),
      })),
    };
  }

  publishWorkflowDraft(input: {
    id: string;
    expectedVersion: number;
  }): PublishedWorkflowDraftView {
    return publishedWorkflowDraftView(this.ledger.publishWorkflowDraft(input));
  }

  publishAndStartWorkflowDraft(input: PublishAndStartWorkflowDraftInput) {
    const launched = this.ledger.publishAndStartWorkflowDraft(input);
    if (launched.runCreated) this.emit(launched.startedRun.event);
    return {
      ...publishedWorkflowDraftView(launched),
      run: this.getRunSnapshot(launched.startedRun.run.id),
      runCreated: launched.runCreated,
    };
  }

  startRun(input: {
    id?: string;
    workflowRevisionId: string;
    /** Defaults to the creating process cwd; runtimes should pass their pinned workspace. */
    workspace?: string;
    runInput?: unknown;
    parentRunId?: string;
  }): RunSnapshot {
    const workflowRevision = this.ledger.getWorkflowRevision(input.workflowRevisionId);
    if (!workflowRevision) {
      throw new Error(`Unknown workflow revision: ${input.workflowRevisionId}`);
    }
    const started = this.ledger.createStartedRun({
      id: input.id,
      workflowRevisionId: input.workflowRevisionId,
      workspace: input.workspace ?? process.cwd(),
      input: input.runInput,
      parentRunId: input.parentRunId,
    }, {
      workflowRevisionId: workflowRevision.id,
      workflowId: workflowRevision.workflowId,
    });
    this.emit(started.event);
    return this.getRunSnapshot(started.run.id);
  }

  getRunSnapshot(runId: string): RunSnapshot {
    const run = this.ledger.getRun(runId);
    if (!run) {
      throw new Error(`Unknown run: ${runId}`);
    }
    const workflowRevision = this.ledger.getWorkflowRevision(run.workflowRevisionId);
    if (!workflowRevision) {
      throw new Error(
        `Run ${runId} references missing workflow revision ${run.workflowRevisionId}`,
      );
    }
    return {
      run,
      workflowRevision,
      events: this.ledger.listAllEvents(runId),
      approvals: this.ledger.listPendingApprovals(runId),
      artifacts: this.ledger.listArtifacts(runId),
    };
  }

  listRuns(limit = 100): DurableRunRecord[] {
    return this.ledger.listRuns(limit);
  }

  appendEvent(
    runId: string,
    type: string,
    payload: unknown = null,
    options: {
      expectedSequence?: number;
      idempotencyKey?: string;
    } = {},
  ): DurableRunEvent {
    this.assertMutable(runId);
    const previousSequence = this.ledger.getRun(runId)!.lastSequence;
    const event = this.ledger.appendEvent(runId, type, payload, options);
    for (const committed of this.ledger.listEvents(runId, previousSequence)) {
      this.emit(committed);
    }
    return event;
  }

  scheduleNodeAttempt(
    input: Parameters<RunLedger['scheduleNodeAttempt']>[0],
  ): DurableNodeAttemptRecord {
    this.assertMutable(input.runId);
    const previousSequence = this.ledger.getRun(input.runId)!.lastSequence;
    const attempt = this.ledger.scheduleNodeAttempt(input);
    const event = this.ledger.listEvents(input.runId, previousSequence).at(-1);
    if (event) this.emit(event);
    return attempt;
  }

  claimNodeAttempt(
    input: Parameters<RunLedger['claimNodeAttempt']>[0],
  ): DurableNodeAttemptRecord | undefined {
    const current = this.ledger.getNodeAttempt(input.id);
    if (!current) throw new Error(`Unknown node attempt: ${input.id}`);
    this.assertMutable(current.runId);
    const previousSequence = this.ledger.getRun(current.runId)!.lastSequence;
    const attempt = this.ledger.claimNodeAttempt(input);
    const event = this.ledger.listEvents(current.runId, previousSequence).at(-1);
    if (event) this.emit(event);
    return attempt;
  }

  renewNodeAttemptLease(
    input: Parameters<RunLedger['renewNodeAttemptLease']>[0],
  ): DurableNodeAttemptRecord {
    return this.ledger.renewNodeAttemptLease(input);
  }

  completeNodeAttempt(
    input: Parameters<RunLedger['completeNodeAttempt']>[0],
  ): DurableNodeAttemptRecord {
    const current = this.ledger.getNodeAttempt(input.id);
    if (!current) throw new Error(`Unknown node attempt: ${input.id}`);
    this.assertMutable(current.runId);
    const previousSequence = this.ledger.getRun(current.runId)!.lastSequence;
    const attempt = this.ledger.completeNodeAttempt(input);
    const event = this.ledger.listEvents(current.runId, previousSequence).at(-1);
    if (event) this.emit(event);
    return attempt;
  }

  recoverExpiredNodeAttempts(now?: string, workspace?: string): DurableNodeAttemptRecord[] {
    const before = new Map(this.listRuns(1_000).map(run => [run.id, run.lastSequence]));
    const attempts = this.ledger.recoverExpiredNodeAttempts(now, workspace);
    for (const runId of new Set(attempts.map(attempt => attempt.runId))) {
      for (const event of this.ledger.listEvents(runId, before.get(runId) ?? 0)) {
        this.emit(event);
      }
    }
    return attempts;
  }

  pauseRun(runId: string): RunSnapshot {
    this.assertMutable(runId);
    const run = this.ledger.getRun(runId)!;
    this.assertWorkspacePinned(run);
    if (run.status !== 'waiting') {
      this.appendEvent(runId, 'run.paused', null, {
        idempotencyKey: `run:pause:${run.lastSequence}`,
      });
    }
    return this.getRunSnapshot(runId);
  }

  resumeRun(runId: string): RunSnapshot {
    const run = this.ledger.getRun(runId);
    if (!run) {
      throw new Error(`Unknown run: ${runId}`);
    }
    this.assertWorkspacePinned(run);
    if (TERMINAL_STATUSES.has(run.status)) {
      throw new Error(`Run ${runId} is terminal (${run.status})`);
    }
    if (run.status === 'waiting') {
      if (this.ledger.listPendingApprovals(runId).length > 0) {
        throw new Error(`Run ${runId} is waiting for approval; resolve the approval instead`);
      }
      this.appendEvent(runId, 'run.resumed', null, {
        idempotencyKey: `run:resume:${run.lastSequence}`,
      });
    }
    return this.getRunSnapshot(runId);
  }

  cancelRun(runId: string): RunSnapshot {
    const run = this.ledger.getRun(runId);
    if (!run) {
      throw new Error(`Unknown run: ${runId}`);
    }
    this.assertWorkspacePinned(run);
    if (run.status !== 'cancelled') {
      if (TERMINAL_STATUSES.has(run.status)) {
        throw new Error(`Run ${runId} is terminal (${run.status})`);
      }
      this.appendEvent(runId, 'run.cancelled', null, {
        idempotencyKey: 'run:cancel',
      });
    }
    return this.getRunSnapshot(runId);
  }

  requestApproval(input: Parameters<RunLedger['requestApproval']>[0]): ApprovalRecord {
    this.assertMutable(input.runId);
    const previousSequence = this.ledger.getRun(input.runId)!.lastSequence;
    const approval = this.ledger.requestApproval(input);
    this.emitPersistedEvents(input.runId, previousSequence);
    return approval;
  }

  resolveApproval(input: Parameters<RunLedger['resolveApproval']>[0]): ApprovalRecord {
    const current = this.ledger.getApproval(input.id);
    if (!current) throw new Error(`Unknown approval: ${input.id}`);
    const previousSequence = this.ledger.getRun(current.runId)?.lastSequence ?? 0;
    const approval = this.ledger.resolveApproval(input);
    for (const event of this.ledger.listEvents(approval.runId, previousSequence)) {
      this.emit(event);
    }
    return approval;
  }

  recordArtifact(input: Parameters<RunLedger['recordArtifact']>[0]): ArtifactRecord {
    this.assertMutable(input.runId);
    const previousSequence = this.ledger.getRun(input.runId)!.lastSequence;
    const artifact = this.ledger.recordArtifact(input);
    this.emitPersistedEvents(input.runId, previousSequence);
    return artifact;
  }

  subscribe(runId: string | '*', listener: RunEventListener): () => void {
    this.#events.on(runId, listener);
    return () => this.#events.off(runId, listener);
  }

  /** Broadcast events committed directly by an embedded durable subsystem. */
  emitPersistedEvents(runId: string, afterSequence: number): DurableRunEvent[] {
    const events = this.ledger.listAllEvents(runId, afterSequence);
    for (const event of events) this.emit(event);
    return events;
  }

  close(): void {
    this.#events.removeAllListeners();
    this.ledger.close();
  }

  private assertMutable(runId: string): void {
    const run = this.ledger.getRun(runId);
    if (!run) {
      throw new Error(`Unknown run: ${runId}`);
    }
    if (TERMINAL_STATUSES.has(run.status)) {
      throw new Error(`Run ${runId} is terminal (${run.status})`);
    }
  }

  private assertWorkspacePinned(run: DurableRunRecord): void {
    if (!run.workspace) {
      throw new Error(
        `Run ${run.id} has no pinned workspace and is observer-only; start a new run to execute it.`,
      );
    }
  }

  private emit(event: DurableRunEvent): void {
    this.#events.emit(event.runId, event);
    this.#events.emit('*', event);
  }
}
