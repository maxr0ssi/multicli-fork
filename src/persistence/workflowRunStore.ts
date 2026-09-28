import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { requireSafeLocalIdentifier } from '../utils/safeIdentifier.js';
import { canonicalWorkspace } from '../utils/canonicalWorkspace.js';
import {
  contentHash,
  encode,
  LedgerCore,
  many,
  mapEvent,
  mapRun,
  mapWorkflow,
  nowIso,
  one,
} from './ledgerCore.js';
import type {
  AppendEventOptions,
  CreateRunInput,
  DurableRunEvent,
  DurableRunRecord,
  RecordWorkflowRevisionInput,
  RunStatus,
  StartedRunRecord,
  WorkflowRevisionRecord,
} from './runLedger.types.js';

const STATUS_BY_EVENT: Record<string, RunStatus> = {
  'run.started': 'running',
  'run.paused': 'waiting',
  'run.waiting': 'waiting',
  'run.resumed': 'running',
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.budget_exhausted': 'failed',
  'run.cancelled': 'cancelled',
};

export class WorkflowRunStore {
  constructor(private readonly core: LedgerCore) {}

  recordWorkflowRevision(input: RecordWorkflowRevisionInput): WorkflowRevisionRecord {
    const hash = contentHash(input.definition);
    const existing = one(
      this.core.db.prepare(
        'SELECT * FROM workflow_revisions WHERE workflow_id = ? AND content_hash = ?',
      ),
      input.workflowId,
      hash,
    );
    if (existing) return mapWorkflow(existing);

    const record: WorkflowRevisionRecord = {
      id: input.id ?? randomUUID(), workflowId: input.workflowId, contentHash: hash,
      definition: input.definition, createdAt: input.createdAt ?? nowIso(),
    };
    this.core.db.prepare(`
      INSERT INTO workflow_revisions(id, workflow_id, content_hash, definition_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(record.id, record.workflowId, record.contentHash, encode(record.definition), record.createdAt);
    return record;
  }

  getWorkflowRevision(id: string): WorkflowRevisionRecord | undefined {
    const row = one(this.core.db.prepare('SELECT * FROM workflow_revisions WHERE id = ?'), id);
    return row ? mapWorkflow(row) : undefined;
  }

  listWorkflowRevisions(workflowId?: string): WorkflowRevisionRecord[] {
    const rows = workflowId
      ? many(this.core.db.prepare(`
        SELECT * FROM workflow_revisions WHERE workflow_id = ?
        ORDER BY created_at DESC, id DESC
      `), workflowId)
      : many(this.core.db.prepare(`
        SELECT * FROM workflow_revisions ORDER BY created_at DESC, id DESC
      `));
    return rows.map(mapWorkflow);
  }

  createRun(input: CreateRunInput): DurableRunRecord {
    const timestamp = input.createdAt ?? nowIso();
    const record: DurableRunRecord = {
      id: requireSafeLocalIdentifier(input.id ?? randomUUID(), 'Run id'),
      workflowRevisionId: input.workflowRevisionId,
      workspace: canonicalWorkspace(input.workspace),
      status: 'queued', input: input.input ?? null, createdAt: timestamp,
      updatedAt: timestamp, lastSequence: 0,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    };
    this.insertRun(record);
    return record;
  }

  createStartedRun(input: CreateRunInput, payload: unknown = null): StartedRunRecord {
    return this.core.transaction(() => this.insertStartedRun(input, payload));
  }

  createStartedRunIdempotentlyInTransaction(
    input: CreateRunInput & { id: string },
    payload: unknown = null,
  ): { startedRun: StartedRunRecord; created: boolean } {
    const runId = requireSafeLocalIdentifier(input.id, 'Run id');
    const existing = this.getRun(runId);
    if (!existing) {
      return {
        startedRun: this.insertStartedRun({ ...input, id: runId }, payload),
        created: true,
      };
    }
    const event = this.listEvents(runId, 0, 1)[0];
    const matches = existing.workflowRevisionId === input.workflowRevisionId
      && existing.workspace === canonicalWorkspace(input.workspace)
      && existing.parentRunId === input.parentRunId
      && isDeepStrictEqual(existing.input, input.input ?? null)
      && event?.type === 'run.started'
      && isDeepStrictEqual(event.payload, payload);
    if (!matches) {
      throw new Error(`Run key ${runId} is already bound to a different workflow run`);
    }
    return { startedRun: { run: existing, event }, created: false };
  }

  private insertStartedRun(input: CreateRunInput, payload: unknown): StartedRunRecord {
    const timestamp = input.createdAt ?? nowIso();
    const run: DurableRunRecord = {
      id: requireSafeLocalIdentifier(input.id ?? randomUUID(), 'Run id'),
      workflowRevisionId: input.workflowRevisionId,
      workspace: canonicalWorkspace(input.workspace),
      status: 'running', input: input.input ?? null, createdAt: timestamp,
      updatedAt: timestamp, lastSequence: 1,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    };
    const event: DurableRunEvent = {
      runId: run.id, sequence: 1, timestamp, type: 'run.started', payload,
      idempotencyKey: 'run:start',
    };
    this.insertRun(run);
    this.core.db.prepare(`
      INSERT INTO run_events(
        run_id, sequence, timestamp, type, payload_json, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.runId, event.sequence, event.timestamp, event.type,
      encode(event.payload), 'run:start',
    );
    return { run, event };
  }

  private insertRun(record: DurableRunRecord): void {
    this.core.db.prepare(`
      INSERT INTO runs(
        id, workflow_revision_id, parent_run_id, workspace, status, input_json,
        created_at, updated_at, last_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.workflowRevisionId, record.parentRunId ?? null, record.workspace!,
      record.status,
      encode(record.input), record.createdAt, record.updatedAt, record.lastSequence,
    );
  }

  getRun(id: string): DurableRunRecord | undefined {
    const row = one(this.core.db.prepare('SELECT * FROM runs WHERE id = ?'), id);
    return row ? mapRun(row) : undefined;
  }

  listRuns(limit = 100): DurableRunRecord[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 1_000));
    return many(
      this.core.db.prepare('SELECT * FROM runs ORDER BY updated_at DESC, id DESC LIMIT ?'),
      bounded,
    ).map(mapRun);
  }

  appendEvent(
    runId: string,
    type: string,
    payload: unknown = null,
    options: AppendEventOptions = {},
  ): DurableRunEvent {
    return this.core.transaction(() => {
      if (options.idempotencyKey) {
        const existing = one(
          this.core.db.prepare(
            'SELECT * FROM run_events WHERE run_id = ? AND idempotency_key = ?',
          ),
          runId,
          options.idempotencyKey,
        );
        if (existing) return mapEvent(existing);
      }

      const run = this.core.assertMutableRun(runId);
      const currentSequence = Number(run.last_sequence);
      if (options.expectedSequence !== undefined && options.expectedSequence !== currentSequence) {
        throw new Error(
          `Run ${runId} sequence conflict: expected ${options.expectedSequence}, current ${currentSequence}`,
        );
      }

      const event: DurableRunEvent = {
        runId, sequence: currentSequence + 1, timestamp: options.timestamp ?? nowIso(),
        type, payload,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      };
      this.core.db.prepare(`
        INSERT INTO run_events(
          run_id, sequence, timestamp, type, payload_json, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        event.runId, event.sequence, event.timestamp, event.type,
        encode(event.payload), event.idempotencyKey ?? null,
      );
      const nextStatus = STATUS_BY_EVENT[type];
      this.core.db.prepare(`
        UPDATE runs SET last_sequence = ?, updated_at = ?, status = COALESCE(?, status)
        WHERE id = ?
      `).run(event.sequence, event.timestamp, nextStatus ?? null, runId);
      if (nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'cancelled') {
        const pending = many(this.core.db.prepare(`
          SELECT id, action_hash FROM approvals
          WHERE run_id = ? AND status = 'pending'
          ORDER BY requested_at, id
        `), runId);
        for (const approval of pending) {
          this.core.db.prepare(`
            UPDATE approvals SET status = 'expired', resolved_at = ?
            WHERE id = ? AND status = 'pending'
          `).run(event.timestamp, String(approval.id));
          this.core.appendEventUnsafe(runId, 'approval.expired', {
            approvalId: String(approval.id),
            actionHash: String(approval.action_hash),
            reason: 'run-terminal',
            runStatus: nextStatus,
          });
        }
      }
      return event;
    });
  }

  listEvents(runId: string, afterSequence = 0, limit = 1_000): DurableRunEvent[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 10_000));
    return many(
      this.core.db.prepare(`
        SELECT * FROM run_events WHERE run_id = ? AND sequence > ?
        ORDER BY sequence ASC LIMIT ?
      `),
      runId,
      Math.max(0, Math.trunc(afterSequence)),
      bounded,
    ).map(mapEvent);
  }

  listAllEvents(runId: string, afterSequence = 0): DurableRunEvent[] {
    const events: DurableRunEvent[] = [];
    let cursor = Math.max(0, Math.trunc(afterSequence));
    while (true) {
      const page = this.listEvents(runId, cursor, 10_000);
      events.push(...page);
      if (page.length < 10_000) return events;
      cursor = page.at(-1)!.sequence;
    }
  }
}
