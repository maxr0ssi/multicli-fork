import { randomUUID } from 'node:crypto';
import { canonicalWorkspace } from '../utils/canonicalWorkspace.js';
import {
  isTerminalRunStatus,
  LedgerCore,
  many,
  mapNodeAttempt,
  nowIso,
  one,
  parseTimestamp,
} from './ledgerCore.js';
import type {
  ClaimNodeAttemptInput,
  CompleteNodeAttemptInput,
  DurableNodeAttemptRecord,
  RenewNodeAttemptLeaseInput,
  ScheduleNodeAttemptInput,
} from './runLedger.types.js';

export class NodeAttemptStore {
  constructor(private readonly core: LedgerCore) {}

  scheduleNodeAttempt(input: ScheduleNodeAttemptInput): DurableNodeAttemptRecord {
    return this.core.transaction(() => {
      const existing = one(
        this.core.db.prepare('SELECT * FROM node_attempts WHERE idempotency_key = ?'),
        input.idempotencyKey,
      );
      if (existing) return mapNodeAttempt(existing);
      this.core.assertMutableRun(input.runId);
      const nextNumber = input.attemptNumber ?? Number(one(
        this.core.db.prepare(
          'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM node_attempts WHERE run_id = ? AND node_id = ?',
        ),
        input.runId,
        input.nodeId,
      )?.next ?? 1);
      const timestamp = nowIso();
      const record: DurableNodeAttemptRecord = {
        id: input.id ?? randomUUID(), runId: input.runId, nodeId: input.nodeId,
        attemptNumber: nextNumber, status: 'queued', idempotencyKey: input.idempotencyKey,
        createdAt: timestamp, updatedAt: timestamp,
      };
      this.core.db.prepare(`
        INSERT INTO node_attempts(
          id, run_id, node_id, attempt_number, status, idempotency_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.runId, record.nodeId, record.attemptNumber,
        record.status, record.idempotencyKey, record.createdAt, record.updatedAt,
      );
      this.core.appendEventUnsafe(record.runId, 'node.queued', {
        nodeId: record.nodeId, attemptId: record.id, attemptNumber: record.attemptNumber,
      });
      return record;
    });
  }

  claimNodeAttempt(input: ClaimNodeAttemptInput): DurableNodeAttemptRecord | undefined {
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error('Node attempt leaseMs must be positive');
    }
    return this.core.transaction(() => {
      const row = one(this.core.db.prepare('SELECT * FROM node_attempts WHERE id = ?'), input.id);
      if (!row) throw new Error(`Unknown node attempt: ${input.id}`);
      const current = mapNodeAttempt(row);
      this.core.assertMutableRun(current.runId);
      const now = input.now ?? nowIso();
      const timestamp = parseTimestamp(now, 'Node attempt lease time');
      if (current.status !== 'queued') return undefined;
      const leaseExpiresAt = new Date(timestamp + input.leaseMs).toISOString();
      this.core.db.prepare(`
        UPDATE node_attempts
        SET status = 'running', lease_owner = ?, lease_expires_at = ?,
            started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ?
      `).run(input.workerId, leaseExpiresAt, now, now, input.id);
      this.core.appendEventUnsafe(current.runId, 'node.started', {
        nodeId: current.nodeId, attemptId: current.id,
        attemptNumber: current.attemptNumber, workerId: input.workerId, leaseExpiresAt,
      });
      return mapNodeAttempt(one(
        this.core.db.prepare('SELECT * FROM node_attempts WHERE id = ?'),
        input.id,
      )!);
    });
  }

  renewNodeAttemptLease(input: RenewNodeAttemptLeaseInput): DurableNodeAttemptRecord {
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error('Node attempt leaseMs must be positive');
    }
    return this.core.transaction(() => {
      const row = one(this.core.db.prepare('SELECT * FROM node_attempts WHERE id = ?'), input.id);
      if (!row) throw new Error(`Unknown node attempt: ${input.id}`);
      const current = mapNodeAttempt(row);
      this.core.assertMutableRun(current.runId);
      if (current.status !== 'running' || current.leaseOwner !== input.workerId) {
        throw new Error(`Node attempt ${input.id} is not leased by ${input.workerId}`);
      }
      const now = input.now ?? nowIso();
      const heartbeatAt = parseTimestamp(now, 'Node attempt heartbeat time');
      const currentExpiry = current.leaseExpiresAt ? Date.parse(current.leaseExpiresAt) : Number.NaN;
      if (!Number.isFinite(currentExpiry) || currentExpiry <= heartbeatAt) {
        throw new Error(`Node attempt ${input.id} lease has expired`);
      }
      const leaseExpiresAt = new Date(heartbeatAt + input.leaseMs).toISOString();
      this.core.db.prepare(`
        UPDATE node_attempts
        SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
      `).run(leaseExpiresAt, now, input.id, input.workerId);
      return mapNodeAttempt(one(
        this.core.db.prepare('SELECT * FROM node_attempts WHERE id = ?'),
        input.id,
      )!);
    });
  }

  completeNodeAttempt(input: CompleteNodeAttemptInput): DurableNodeAttemptRecord {
    return this.core.transaction(() => {
      const row = one(this.core.db.prepare('SELECT * FROM node_attempts WHERE id = ?'), input.id);
      if (!row) throw new Error(`Unknown node attempt: ${input.id}`);
      const current = mapNodeAttempt(row);
      this.core.assertMutableRun(current.runId);
      if (current.status !== 'running' || current.leaseOwner !== input.workerId) {
        throw new Error(`Node attempt ${input.id} is not leased by ${input.workerId}`);
      }
      const timestamp = input.now ?? nowIso();
      const completedAt = parseTimestamp(timestamp, 'Node attempt completion time');
      const leaseExpiresAt = current.leaseExpiresAt
        ? Date.parse(current.leaseExpiresAt)
        : Number.NaN;
      if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= completedAt) {
        throw new Error(`Node attempt ${input.id} lease has expired`);
      }
      if (input.retryable !== undefined && typeof input.retryable !== 'boolean') {
        throw new Error('Node attempt retryable must be a boolean');
      }
      if (input.usage) {
        for (const [key, value] of Object.entries(input.usage)) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            throw new Error(`Node attempt usage ${key} must be a non-negative finite number`);
          }
        }
      }
      this.core.db.prepare(`
        UPDATE node_attempts
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
            output_artifact_id = ?, error = ?, finished_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.status, input.outputArtifactId ?? null, input.error ?? null,
        timestamp, timestamp, input.id,
      );
      this.core.appendEventUnsafe(current.runId, `node.${input.status}`, {
        nodeId: current.nodeId, attemptId: current.id, attemptNumber: current.attemptNumber,
        ...(input.outputArtifactId ? { outputArtifactId: input.outputArtifactId } : {}),
        ...(input.error ? { error: input.error } : {}),
        ...(input.status === 'failed' && input.retryable !== undefined
          ? { retryable: input.retryable } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
      });
      return mapNodeAttempt(one(
        this.core.db.prepare('SELECT * FROM node_attempts WHERE id = ?'),
        input.id,
      )!);
    });
  }

  listNodeAttempts(runId: string): DurableNodeAttemptRecord[] {
    return many(this.core.db.prepare(`
      SELECT * FROM node_attempts WHERE run_id = ? ORDER BY node_id, attempt_number
    `), runId).map(mapNodeAttempt);
  }

  getNodeAttempt(id: string): DurableNodeAttemptRecord | undefined {
    const row = one(this.core.db.prepare('SELECT * FROM node_attempts WHERE id = ?'), id);
    return row ? mapNodeAttempt(row) : undefined;
  }

  recoverExpiredNodeAttempts(now = nowIso(), workspace?: string): DurableNodeAttemptRecord[] {
    parseTimestamp(now, 'Node attempt recovery time');
    const pinnedWorkspace = workspace ? canonicalWorkspace(workspace) : undefined;
    return this.core.transaction(() => {
      const recoverable = many(this.core.db.prepare(`
        SELECT node_attempts.*, runs.status AS run_status
        FROM node_attempts JOIN runs ON runs.id = node_attempts.run_id
        WHERE node_attempts.status = 'running'
          AND (? IS NULL OR runs.workspace = ?)
          AND (
            runs.status IN ('completed', 'failed', 'cancelled')
            OR node_attempts.lease_expires_at IS NULL
            OR julianday(node_attempts.lease_expires_at) IS NULL
            OR julianday(node_attempts.lease_expires_at) <= julianday(?)
          )
        ORDER BY node_attempts.run_id, node_attempts.node_id, node_attempts.attempt_number
      `), pinnedWorkspace ?? null, pinnedWorkspace ?? null, now)
        .map(row => ({ attempt: mapNodeAttempt(row), runStatus: String(row.run_status) }));
      const recovered: DurableNodeAttemptRecord[] = [];
      for (const { attempt, runStatus } of recoverable) {
        const terminalRun = isTerminalRunStatus(runStatus);
        const expiresAt = attempt.leaseExpiresAt ? Date.parse(attempt.leaseExpiresAt) : Number.NaN;
        const error = terminalRun
          ? 'Run is terminal; lease released without committing a result'
          : Number.isFinite(expiresAt)
            ? 'Lease expired; manual retry required'
            : 'Lease missing or invalid; manual retry required';
        const status: 'cancelled' | 'failed' = terminalRun ? 'cancelled' : 'failed';
        this.core.db.prepare(`
          UPDATE node_attempts
          SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
              finished_at = ?, error = ?, updated_at = ? WHERE id = ?
        `).run(status, now, error, now, attempt.id);
        if (!terminalRun) {
          this.core.appendEventUnsafe(attempt.runId, 'node.failed', {
            nodeId: attempt.nodeId, attemptId: attempt.id,
            previousWorkerId: attempt.leaseOwner, error, retryable: false,
          });
        }
        recovered.push({
          ...attempt, status, leaseOwner: undefined, leaseExpiresAt: undefined,
          finishedAt: now, error, updatedAt: now,
        });
      }
      return recovered;
    });
  }
}
