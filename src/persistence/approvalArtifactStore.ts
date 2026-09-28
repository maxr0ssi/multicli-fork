import { randomUUID } from 'node:crypto';
import {
  encode,
  LedgerCore,
  many,
  mapApproval,
  mapArtifact,
  nowIso,
  one,
} from './ledgerCore.js';
import type {
  ApprovalRecord,
  ArtifactRecord,
  RecordArtifactInput,
  RequestApprovalInput,
  ResolveApprovalInput,
} from './runLedger.types.js';

export class ApprovalArtifactStore {
  constructor(private readonly core: LedgerCore) {}

  requestApproval(input: RequestApprovalInput): ApprovalRecord {
    const record: ApprovalRecord = {
      id: input.id ?? randomUUID(), runId: input.runId,
      ...(input.nodeAttemptId ? { nodeAttemptId: input.nodeAttemptId } : {}),
      actionHash: input.actionHash, risk: input.risk, payload: input.payload ?? null,
      status: 'pending', requestedAt: nowIso(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    this.core.transaction(() => {
      this.core.assertMutableRun(record.runId);
      this.core.db.prepare(`
        INSERT INTO approvals(
          id, run_id, node_attempt_id, action_hash, risk, payload_json,
          status, requested_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.runId, record.nodeAttemptId ?? null, record.actionHash,
        record.risk, encode(record.payload), record.status, record.requestedAt,
        record.expiresAt ?? null,
      );
      this.core.appendEventUnsafe(record.runId, 'approval.requested', {
        approvalId: record.id, actionHash: record.actionHash, risk: record.risk,
      });
    });
    return record;
  }

  resolveApproval(input: ResolveApprovalInput): ApprovalRecord {
    return this.core.transaction(() => {
      const row = one(this.core.db.prepare('SELECT * FROM approvals WHERE id = ?'), input.id);
      if (!row) throw new Error(`Unknown approval: ${input.id}`);
      const current = mapApproval(row);
      if (current.status !== 'pending') {
        throw new Error(`Approval ${input.id} is already ${current.status}`);
      }
      if (current.actionHash !== input.actionHash) {
        throw new Error(`Approval ${input.id} action hash changed`);
      }
      if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) {
        const resolvedAt = nowIso();
        this.core.db.prepare('UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?')
          .run('expired', resolvedAt, input.id);
        this.core.appendEventUnsafe(current.runId, 'approval.expired', {
          approvalId: current.id, actionHash: current.actionHash,
        });
        return { ...current, status: 'expired', resolvedAt };
      }
      this.core.assertMutableRun(current.runId);

      const resolvedAt = nowIso();
      this.core.db.prepare(`
        UPDATE approvals SET status = ?, resolved_at = ?, decision_by = ? WHERE id = ?
      `).run(input.decision, resolvedAt, input.decisionBy, input.id);
      this.core.appendEventUnsafe(current.runId, 'approval.resolved', {
        approvalId: current.id, decision: input.decision,
        decisionBy: input.decisionBy, actionHash: input.actionHash,
      });
      return { ...current, status: input.decision, resolvedAt, decisionBy: input.decisionBy };
    });
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = one(this.core.db.prepare('SELECT * FROM approvals WHERE id = ?'), id);
    return row ? mapApproval(row) : undefined;
  }

  listApprovals(runId?: string, limit = 1_000): ApprovalRecord[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 10_000));
    const rows = runId
      ? many(this.core.db.prepare(`
        SELECT * FROM approvals WHERE run_id = ?
        ORDER BY requested_at, id LIMIT ?
      `), runId, bounded)
      : many(this.core.db.prepare(`
        SELECT * FROM approvals ORDER BY requested_at DESC, id DESC LIMIT ?
      `), bounded);
    return rows.map(mapApproval);
  }

  listPendingApprovals(runId?: string): ApprovalRecord[] {
    const statement = runId
      ? this.core.db.prepare(
        'SELECT * FROM approvals WHERE status = ? AND run_id = ? ORDER BY requested_at',
      )
      : this.core.db.prepare(
        'SELECT * FROM approvals WHERE status = ? ORDER BY requested_at',
      );
    const rows = runId ? many(statement, 'pending', runId) : many(statement, 'pending');
    return rows.map(mapApproval);
  }

  recordArtifact(input: RecordArtifactInput): ArtifactRecord {
    const record: ArtifactRecord = {
      id: input.id ?? randomUUID(), runId: input.runId,
      ...(input.nodeAttemptId ? { nodeAttemptId: input.nodeAttemptId } : {}),
      contentHash: input.contentHash, mediaType: input.mediaType, name: input.name,
      location: input.location, metadata: input.metadata ?? null, createdAt: nowIso(),
    };
    this.core.transaction(() => {
      this.core.assertMutableRun(record.runId);
      this.core.db.prepare(`
        INSERT INTO artifacts(
          id, run_id, node_attempt_id, content_hash, media_type, name,
          location, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.runId, record.nodeAttemptId ?? null, record.contentHash,
        record.mediaType, record.name, record.location, encode(record.metadata), record.createdAt,
      );
      this.core.appendEventUnsafe(record.runId, 'artifact.created', {
        artifactId: record.id, contentHash: record.contentHash,
        mediaType: record.mediaType, name: record.name,
      });
    });
    return record;
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    return many(
      this.core.db.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, id'),
      runId,
    ).map(mapArtifact);
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const row = one(this.core.db.prepare('SELECT * FROM artifacts WHERE id = ?'), id);
    return row ? mapArtifact(row) : undefined;
  }
}
