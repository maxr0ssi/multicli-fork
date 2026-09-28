import { createHash } from 'node:crypto';
import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  ApprovalRecord,
  ArtifactRecord,
  DurableNodeAttemptRecord,
  DurableRunEvent,
  DurableRunRecord,
  GoalSessionArtifactKind,
  GoalSessionArtifactRecord,
  GoalSessionRecord,
  GoalSessionStatus,
  GoalSessionTurnState,
  RunStatus,
  WorkflowRevisionRecord,
} from './runLedger.types.js';

export type SqlRow = Record<string, unknown>;

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'completed',
  'failed',
  'cancelled',
]);

export function isTerminalRunStatus(status: string): status is RunStatus {
  return TERMINAL_RUN_STATUSES.has(status as RunStatus);
}

export function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be an ISO-parseable timestamp`);
  }
  return timestamp;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(',')}}`;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function encode(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function decode(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : null;
}

function optionalString(row: SqlRow, key: string): string | undefined {
  return row[key] == null ? undefined : String(row[key]);
}

export function mapWorkflow(row: SqlRow): WorkflowRevisionRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    contentHash: String(row.content_hash),
    definition: decode(row.definition_json),
    createdAt: String(row.created_at),
  };
}

export function mapRun(row: SqlRow): DurableRunRecord {
  const parentRunId = optionalString(row, 'parent_run_id');
  const workspace = optionalString(row, 'workspace');
  return {
    id: String(row.id),
    workflowRevisionId: String(row.workflow_revision_id),
    status: String(row.status) as RunStatus,
    input: decode(row.input_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastSequence: Number(row.last_sequence),
    ...(workspace ? { workspace } : {}),
    ...(parentRunId ? { parentRunId } : {}),
  };
}

export function mapEvent(row: SqlRow): DurableRunEvent {
  const idempotencyKey = optionalString(row, 'idempotency_key');
  return {
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    timestamp: String(row.timestamp),
    type: String(row.type),
    payload: decode(row.payload_json),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

export function mapApproval(row: SqlRow): ApprovalRecord {
  const nodeAttemptId = optionalString(row, 'node_attempt_id');
  const resolvedAt = optionalString(row, 'resolved_at');
  const expiresAt = optionalString(row, 'expires_at');
  const decisionBy = optionalString(row, 'decision_by');
  return {
    id: String(row.id), runId: String(row.run_id),
    ...(nodeAttemptId ? { nodeAttemptId } : {}),
    actionHash: String(row.action_hash), risk: String(row.risk),
    payload: decode(row.payload_json), status: String(row.status) as ApprovalRecord['status'],
    requestedAt: String(row.requested_at),
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(decisionBy ? { decisionBy } : {}),
  };
}

export function mapArtifact(row: SqlRow): ArtifactRecord {
  const nodeAttemptId = optionalString(row, 'node_attempt_id');
  return {
    id: String(row.id), runId: String(row.run_id), ...(nodeAttemptId ? { nodeAttemptId } : {}),
    contentHash: String(row.content_hash), mediaType: String(row.media_type),
    name: String(row.name), location: String(row.location),
    metadata: decode(row.metadata_json), createdAt: String(row.created_at),
  };
}

export function mapNodeAttempt(row: SqlRow): DurableNodeAttemptRecord {
  const optional = (key: string): string | undefined => optionalString(row, key);
  return {
    id: String(row.id), runId: String(row.run_id), nodeId: String(row.node_id),
    attemptNumber: Number(row.attempt_number),
    status: String(row.status) as DurableNodeAttemptRecord['status'],
    idempotencyKey: String(row.idempotency_key),
    ...(optional('lease_owner') ? { leaseOwner: optional('lease_owner') } : {}),
    ...(optional('lease_expires_at') ? { leaseExpiresAt: optional('lease_expires_at') } : {}),
    ...(optional('started_at') ? { startedAt: optional('started_at') } : {}),
    ...(optional('finished_at') ? { finishedAt: optional('finished_at') } : {}),
    ...(optional('output_artifact_id') ? { outputArtifactId: optional('output_artifact_id') } : {}),
    ...(optional('error') ? { error: optional('error') } : {}),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function mapGoalSession(row: SqlRow): GoalSessionRecord {
  const pick = (key: string) => optionalString(row, key);
  return {
    id: String(row.id),
    ...(pick('run_id') ? { runId: pick('run_id') } : {}),
    ...(pick('workflow_revision_id') ? { workflowRevisionId: pick('workflow_revision_id') } : {}),
    profileId: String(row.profile_id), provider: String(row.provider), model: String(row.model),
    ...(pick('reasoning_effort') ? { reasoningEffort: pick('reasoning_effort') } : {}),
    workspaceAccess: String(row.workspace_access),
    selection: String(row.selection_policy) as GoalSessionRecord['selection'],
    enableSubagents: Number(row.enable_subagents) === 1,
    cwd: String(row.cwd),
    ...(pick('native_session_id') ? { nativeSessionId: pick('native_session_id') } : {}),
    status: String(row.status) as GoalSessionStatus,
    turnState: String(row.turn_state) as GoalSessionTurnState,
    turnCount: Number(row.turn_count), goalArtifactId: String(row.goal_artifact_id),
    ...(pick('last_instruction_artifact_id')
      ? { lastInstructionArtifactId: pick('last_instruction_artifact_id') } : {}),
    ...(pick('last_reply_artifact_id')
      ? { lastReplyArtifactId: pick('last_reply_artifact_id') } : {}),
    ...(pick('turn_owner') ? { turnOwner: pick('turn_owner') } : {}),
    ...(pick('turn_lease_expires_at') ? { turnLeaseExpiresAt: pick('turn_lease_expires_at') } : {}),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...(pick('closed_at') ? { closedAt: pick('closed_at') } : {}),
  };
}

export function mapGoalSessionArtifact(row: SqlRow): GoalSessionArtifactRecord {
  return {
    id: String(row.id), sessionId: String(row.session_id),
    ...(row.turn_number == null ? {} : { turnNumber: Number(row.turn_number) }),
    kind: String(row.kind) as GoalSessionArtifactKind,
    contentHash: String(row.content_hash), mediaType: String(row.media_type),
    name: String(row.name), location: String(row.location),
    metadata: decode(row.metadata_json), createdAt: String(row.created_at),
  };
}

export function one(statement: StatementSync, ...params: unknown[]): SqlRow | undefined {
  return statement.get(...params as never[]) as SqlRow | undefined;
}

export function many(statement: StatementSync, ...params: unknown[]): SqlRow[] {
  return statement.all(...params as never[]) as SqlRow[];
}

export class LedgerCore {
  constructor(readonly db: DatabaseSync) {}

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  assertMutableRun(runId: string): SqlRow {
    const run = one(this.db.prepare('SELECT status, last_sequence FROM runs WHERE id = ?'), runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (isTerminalRunStatus(String(run.status))) {
      throw new Error(`Run ${runId} is terminal (${String(run.status)})`);
    }
    return run;
  }

  appendEventUnsafe(runId: string, type: string, payload: unknown): DurableRunEvent {
    const run = one(this.db.prepare('SELECT last_sequence FROM runs WHERE id = ?'), runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const event = { runId, sequence: Number(run.last_sequence) + 1, timestamp: nowIso(), type, payload };
    this.db.prepare(`
      INSERT INTO run_events(run_id, sequence, timestamp, type, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, event.sequence, event.timestamp, type, encode(payload));
    this.db.prepare('UPDATE runs SET last_sequence = ?, updated_at = ? WHERE id = ?')
      .run(event.sequence, event.timestamp, runId);
    return event;
  }
}
