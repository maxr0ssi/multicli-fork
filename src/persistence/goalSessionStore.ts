import { randomUUID } from 'node:crypto';
import {
  encode,
  isTerminalRunStatus,
  LedgerCore,
  many,
  mapGoalSession,
  mapGoalSessionArtifact,
  mapRun,
  nowIso,
  one,
  parseTimestamp,
} from './ledgerCore.js';
import type {
  BlockGoalSessionTurnInput,
  ClaimGoalSessionTurnInput,
  CompleteGoalSessionTurnInput,
  CreateGoalSessionInput,
  FailGoalSessionTurnInput,
  GoalSessionArtifactRecord,
  GoalSessionRecord,
  RecordGoalSessionArtifactInput,
  RenewGoalSessionTurnLeaseInput,
} from './runLedger.types.js';

export class GoalSessionLedgerStore {
  constructor(private readonly core: LedgerCore) {}

  createGoalSession(input: CreateGoalSessionInput): GoalSessionRecord {
    return this.core.transaction(() => {
      let workflowRevisionId = input.workflowRevisionId;
      if (input.runId) {
        const persistedRun = one(
          this.core.db.prepare('SELECT workflow_revision_id FROM runs WHERE id = ?'),
          input.runId,
        );
        if (!persistedRun) throw new Error(`Unknown run: ${input.runId}`);
        const runRevisionId = String(persistedRun.workflow_revision_id);
        if (workflowRevisionId && workflowRevisionId !== runRevisionId) {
          throw new Error(
            `Goal session workflow revision ${workflowRevisionId} does not match run ${input.runId}`,
          );
        }
        workflowRevisionId = runRevisionId;
      } else if (workflowRevisionId && !this.workflowRevisionExists(workflowRevisionId)) {
        throw new Error(`Unknown workflow revision: ${workflowRevisionId}`);
      }

      const timestamp = input.createdAt ?? nowIso();
      const sessionId = input.id ?? randomUUID();
      const goalArtifactId = input.goalArtifact.id ?? randomUUID();
      const record: GoalSessionRecord = {
        id: sessionId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(workflowRevisionId ? { workflowRevisionId } : {}),
        profileId: input.profileId, provider: input.provider, model: input.model,
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        workspaceAccess: input.workspaceAccess, selection: input.selection,
        enableSubagents: input.enableSubagents, cwd: input.cwd,
        status: 'active', turnState: 'idle', turnCount: 0, goalArtifactId,
        createdAt: timestamp, updatedAt: timestamp,
      };
      this.core.db.prepare(`
        INSERT INTO goal_sessions(
          id, run_id, workflow_revision_id, profile_id, provider, model,
          reasoning_effort, workspace_access, selection_policy, enable_subagents, cwd,
          status, turn_state, turn_count, goal_artifact_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.runId ?? null, record.workflowRevisionId ?? null,
        record.profileId, record.provider, record.model, record.reasoningEffort ?? null,
        record.workspaceAccess, record.selection, record.enableSubagents ? 1 : 0,
        record.cwd, record.status, record.turnState,
        record.turnCount, record.goalArtifactId, record.createdAt, record.updatedAt,
      );
      this.core.db.prepare(`
        INSERT INTO goal_session_artifacts(
          id, session_id, turn_number, kind, content_hash, media_type,
          name, location, metadata_json, created_at
        ) VALUES (?, ?, NULL, 'goal', ?, ?, ?, ?, ?, ?)
      `).run(
        goalArtifactId, sessionId, input.goalArtifact.contentHash,
        input.goalArtifact.mediaType, input.goalArtifact.name, input.goalArtifact.location,
        encode(input.goalArtifact.metadata), timestamp,
      );
      if (this.runCanReceiveEvents(record.runId)) {
        this.core.appendEventUnsafe(record.runId!, 'goal.session.opened', {
          goalSessionId: record.id, workflowRevisionId: record.workflowRevisionId,
          profileId: record.profileId, provider: record.provider, model: record.model,
          reasoningEffort: record.reasoningEffort, workspaceAccess: record.workspaceAccess,
          enableSubagents: record.enableSubagents,
          goalArtifactId,
        });
      }
      return record;
    });
  }

  getGoalSession(id: string): GoalSessionRecord | undefined {
    const row = one(this.core.db.prepare('SELECT * FROM goal_sessions WHERE id = ?'), id);
    return row ? mapGoalSession(row) : undefined;
  }

  listGoalSessions(runId?: string, limit = 100): GoalSessionRecord[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 1_000));
    const rows = runId
      ? many(this.core.db.prepare(`
        SELECT * FROM goal_sessions WHERE run_id = ?
        ORDER BY updated_at DESC, id DESC LIMIT ?
      `), runId, bounded)
      : many(this.core.db.prepare(`
        SELECT * FROM goal_sessions ORDER BY updated_at DESC, id DESC LIMIT ?
      `), bounded);
    return rows.map(mapGoalSession);
  }

  listGoalSessionArtifacts(sessionId: string): GoalSessionArtifactRecord[] {
    return many(this.core.db.prepare(`
      SELECT * FROM goal_session_artifacts WHERE session_id = ? ORDER BY created_at, rowid
    `), sessionId).map(mapGoalSessionArtifact);
  }

  claimGoalSessionTurn(input: ClaimGoalSessionTurnInput): GoalSessionRecord | undefined {
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error('Goal session turn leaseMs must be positive');
    }
    return this.core.transaction(() => {
      const current = this.requireSession(input.id);
      if (current.status !== 'active') throw new Error(`Goal session ${input.id} is ${current.status}`);
      const now = input.now ?? nowIso();
      const nowMs = parseTimestamp(now, 'Goal session turn lease time');
      const previousLease = current.turnLeaseExpiresAt
        ? Date.parse(current.turnLeaseExpiresAt)
        : Number.NaN;
      if (current.turnState === 'running' && Number.isFinite(previousLease) && previousLease > nowMs) {
        return undefined;
      }
      const leaseExpiresAt = new Date(nowMs + input.leaseMs).toISOString();
      this.core.db.prepare(`
        UPDATE goal_sessions
        SET turn_state = 'running', turn_owner = ?, turn_lease_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(input.owner, leaseExpiresAt, now, input.id);
      if (this.runCanReceiveEvents(current.runId)) {
        if (current.turnState === 'running') {
          this.core.appendEventUnsafe(current.runId!, 'goal.turn.recovered', {
            goalSessionId: current.id, abandonedOwner: current.turnOwner,
            turnNumber: current.turnCount + 1,
          });
        }
        this.core.appendEventUnsafe(current.runId!, 'goal.turn.started', {
          goalSessionId: current.id, turnNumber: current.turnCount + 1,
          owner: input.owner, leaseExpiresAt,
        });
      }
      return this.requireSession(input.id);
    });
  }

  renewGoalSessionTurnLease(input: RenewGoalSessionTurnLeaseInput): GoalSessionRecord {
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error('Goal session turn leaseMs must be positive');
    }
    return this.core.transaction(() => {
      const session = this.requireSession(input.id);
      this.assertTurnOwner(session, input.owner);
      const now = input.now ?? nowIso();
      const heartbeatAt = parseTimestamp(now, 'Goal session heartbeat time');
      const currentExpiry = session.turnLeaseExpiresAt
        ? Date.parse(session.turnLeaseExpiresAt)
        : Number.NaN;
      if (!Number.isFinite(currentExpiry) || currentExpiry <= heartbeatAt) {
        throw new Error(`Goal session ${input.id} turn lease has expired`);
      }
      const leaseExpiresAt = new Date(heartbeatAt + input.leaseMs).toISOString();
      this.core.db.prepare(`
        UPDATE goal_sessions
        SET turn_lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND turn_state = 'running' AND turn_owner = ?
      `).run(leaseExpiresAt, now, input.id, input.owner);
      return this.requireSession(input.id);
    });
  }

  recordGoalSessionArtifact(input: RecordGoalSessionArtifactInput): GoalSessionArtifactRecord {
    return this.core.transaction(() => {
      const session = this.requireSession(input.sessionId);
      if (session.status !== 'active' || session.turnState !== 'running') {
        throw new Error(`Goal session ${input.sessionId} has no active turn`);
      }
      if (input.turnNumber !== session.turnCount + 1) {
        throw new Error(
          `Goal session ${input.sessionId} expected turn ${session.turnCount + 1}, received ${input.turnNumber}`,
        );
      }
      const artifact: GoalSessionArtifactRecord = {
        id: input.id ?? randomUUID(), sessionId: input.sessionId,
        turnNumber: input.turnNumber, kind: input.kind, contentHash: input.contentHash,
        mediaType: input.mediaType, name: input.name, location: input.location,
        metadata: input.metadata ?? null, createdAt: input.createdAt ?? nowIso(),
      };
      this.core.db.prepare(`
        INSERT INTO goal_session_artifacts(
          id, session_id, turn_number, kind, content_hash, media_type,
          name, location, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.id, artifact.sessionId, input.turnNumber, artifact.kind,
        artifact.contentHash, artifact.mediaType, artifact.name, artifact.location,
        encode(artifact.metadata), artifact.createdAt,
      );
      return artifact;
    });
  }

  completeGoalSessionTurn(input: CompleteGoalSessionTurnInput): GoalSessionRecord {
    return this.core.transaction(() => {
      const current = this.requireSession(input.id);
      if (current.status !== 'active') throw new Error(`Goal session ${input.id} is closed`);
      this.assertTurnOwner(current, input.owner);
      const timestamp = input.now ?? nowIso();
      const completedAt = parseTimestamp(timestamp, 'Goal session turn completion time');
      const leaseExpiresAt = current.turnLeaseExpiresAt
        ? Date.parse(current.turnLeaseExpiresAt)
        : Number.NaN;
      if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= completedAt) {
        throw new Error(`Goal session ${input.id} turn lease has expired`);
      }
      if (!input.nativeSessionId) throw new Error('Goal session nativeSessionId is required');
      if (current.nativeSessionId && current.nativeSessionId !== input.nativeSessionId) {
        throw new Error(`Goal session ${input.id} native session changed`);
      }
      const turnNumber = current.turnCount + 1;
      const artifacts = many(this.core.db.prepare(`
        SELECT * FROM goal_session_artifacts
        WHERE session_id = ? AND turn_number = ? AND id IN (?, ?)
      `), input.id, turnNumber, input.instructionArtifactId, input.replyArtifactId)
        .map(mapGoalSessionArtifact);
      if (
        artifacts.find(item => item.id === input.instructionArtifactId)?.kind !== 'instruction'
        || artifacts.find(item => item.id === input.replyArtifactId)?.kind !== 'reply'
      ) {
        throw new Error(`Goal session ${input.id} turn artifacts do not match turn ${turnNumber}`);
      }
      this.core.db.prepare(`
        UPDATE goal_sessions
        SET native_session_id = ?, turn_state = 'idle', turn_count = ?,
            last_instruction_artifact_id = ?, last_reply_artifact_id = ?,
            turn_owner = NULL, turn_lease_expires_at = NULL, updated_at = ? WHERE id = ?
      `).run(
        input.nativeSessionId, turnNumber, input.instructionArtifactId,
        input.replyArtifactId, timestamp, input.id,
      );
      if (this.runCanReceiveEvents(current.runId)) {
        this.core.appendEventUnsafe(current.runId!, 'goal.turn.completed', {
          goalSessionId: current.id, turnNumber,
          instructionArtifactId: input.instructionArtifactId,
          replyArtifactId: input.replyArtifactId, nativeSessionPinned: true,
        });
      }
      return this.requireSession(input.id);
    });
  }

  failGoalSessionTurn(input: FailGoalSessionTurnInput): GoalSessionRecord {
    return this.core.transaction(() => {
      const current = this.requireSession(input.id);
      this.assertTurnOwner(current, input.owner);
      const timestamp = input.now ?? nowIso();
      this.core.db.prepare(`
        UPDATE goal_sessions
        SET turn_state = 'idle', turn_owner = NULL, turn_lease_expires_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(timestamp, input.id);
      if (this.runCanReceiveEvents(current.runId)) {
        this.core.appendEventUnsafe(current.runId!, 'goal.turn.failed', {
          goalSessionId: current.id, turnNumber: current.turnCount + 1, reason: input.reason,
        });
      }
      return this.requireSession(input.id);
    });
  }

  blockGoalSessionTurn(input: BlockGoalSessionTurnInput): GoalSessionRecord {
    return this.core.transaction(() => {
      const current = this.requireSession(input.id);
      this.assertTurnOwner(current, input.owner);
      if (current.nativeSessionId && input.nativeSessionId
        && current.nativeSessionId !== input.nativeSessionId) {
        throw new Error(`Goal session ${input.id} native session changed`);
      }
      const timestamp = input.now ?? nowIso();
      this.core.db.prepare(`
        UPDATE goal_sessions
        SET native_session_id = COALESCE(native_session_id, ?), status = 'blocked',
            turn_state = 'idle', turn_owner = NULL, turn_lease_expires_at = NULL,
            updated_at = ? WHERE id = ?
      `).run(input.nativeSessionId ?? null, timestamp, input.id);
      if (this.runCanReceiveEvents(current.runId)) {
        this.core.appendEventUnsafe(current.runId!, 'goal.session.blocked', {
          goalSessionId: current.id, turnNumber: current.turnCount + 1,
          reason: input.reason,
          nativeSessionPinned: Boolean(current.nativeSessionId ?? input.nativeSessionId),
        });
      }
      return this.requireSession(input.id);
    });
  }

  closeGoalSession(id: string, now = nowIso()): GoalSessionRecord {
    return this.core.transaction(() => {
      const current = this.requireSession(id);
      if (current.status === 'closed') return current;
      if (current.turnState === 'running') throw new Error(`Goal session ${id} has a turn in flight`);
      parseTimestamp(now, 'Goal session close time');
      this.core.db.prepare(`
        UPDATE goal_sessions SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, id);
      if (this.runCanReceiveEvents(current.runId)) {
        this.core.appendEventUnsafe(current.runId!, 'goal.session.closed', {
          goalSessionId: current.id, turnCount: current.turnCount,
        });
      }
      return this.requireSession(id);
    });
  }

  private workflowRevisionExists(id: string): boolean {
    return Boolean(one(this.core.db.prepare('SELECT id FROM workflow_revisions WHERE id = ?'), id));
  }

  private requireSession(id: string): GoalSessionRecord {
    const row = one(this.core.db.prepare('SELECT * FROM goal_sessions WHERE id = ?'), id);
    if (!row) throw new Error(`Unknown goal session: ${id}`);
    return mapGoalSession(row);
  }

  private assertTurnOwner(session: GoalSessionRecord, owner: string): void {
    if (session.turnState !== 'running' || session.turnOwner !== owner) {
      throw new Error(`Goal session ${session.id} turn is not leased by ${owner}`);
    }
  }

  private runCanReceiveEvents(runId?: string): boolean {
    if (!runId) return false;
    const row = one(this.core.db.prepare('SELECT * FROM runs WHERE id = ?'), runId);
    return Boolean(row && !isTerminalRunStatus(mapRun(row).status));
  }
}
