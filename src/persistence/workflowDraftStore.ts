import { randomUUID } from 'node:crypto';

import { requireSafeLocalIdentifier } from '../utils/safeIdentifier.js';
import type { WorkflowValidationResult } from '../workflows/graph.js';
import { validateLocalWorkflowRevision } from '../workflows/localModelPolicy.js';
import {
  asWorkflowRevision,
  normalizeWorkflowDraftDefinition,
  workflowDraftRevision,
} from '../workflows/drafts.js';
import {
  encode,
  LedgerCore,
  many,
  nowIso,
  one,
  parseTimestamp,
  type SqlRow,
} from './ledgerCore.js';
import type {
  CreateWorkflowDraftInput,
  PublishedAndStartedWorkflowDraft,
  PublishedWorkflowDraft,
  PublishAndStartWorkflowDraftInput,
  PublishWorkflowDraftInput,
  UpdateWorkflowDraftInput,
  WorkflowDraftRecord,
} from './runLedger.types.js';
import { WorkflowRunStore } from './workflowRunStore.js';

export const MAX_WORKFLOW_DRAFT_BYTES = 1_000_000;
export const MAX_WORKFLOW_DRAFT_NODES = 1_000;
export const MAX_WORKFLOW_DRAFT_EDGES = 10_000;
export const MAX_PROPOSED_RUN_INPUT_BYTES = 256_000;

export class WorkflowDraftValidationError extends Error {
  readonly validation: WorkflowValidationResult;

  constructor(draftId: string, validation: WorkflowValidationResult) {
    super(
      `Workflow draft ${draftId} cannot be published: ${validation.issues
        .map(issue => issue.message)
        .join(' ')}`,
    );
    this.name = 'WorkflowDraftValidationError';
    this.validation = validation;
  }
}

export class WorkflowDraftVersionConflictError extends Error {
  constructor(
    readonly draftId: string,
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `Workflow draft ${draftId} version conflict: expected ${expectedVersion}, current ${currentVersion}`,
    );
    this.name = 'WorkflowDraftVersionConflictError';
  }
}

function decode(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : null;
}

function mapDraft(row: SqlRow): WorkflowDraftRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    version: Number(row.version),
    definition: decode(row.definition_json),
    ...(row.proposed_run_input_json == null
      ? {}
      : { proposedRunInput: decode(row.proposed_run_input_json) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.base_revision_id == null
      ? {}
      : { baseRevisionId: String(row.base_revision_id) }),
    ...(row.published_revision_id == null
      ? {}
      : { publishedRevisionId: String(row.published_revision_id) }),
  };
}

export function assertWorkflowDraftDefinitionLimits(definition: unknown): void {
  const graph = definition as { nodes?: unknown; edges?: unknown };
  if (Array.isArray(graph.nodes) && graph.nodes.length > MAX_WORKFLOW_DRAFT_NODES) {
    throw new Error(`Workflow draft has too many nodes (maximum ${MAX_WORKFLOW_DRAFT_NODES})`);
  }
  if (Array.isArray(graph.edges) && graph.edges.length > MAX_WORKFLOW_DRAFT_EDGES) {
    throw new Error(`Workflow draft has too many edges (maximum ${MAX_WORKFLOW_DRAFT_EDGES})`);
  }
  const json = encode(definition);
  if (Buffer.byteLength(json, 'utf8') > MAX_WORKFLOW_DRAFT_BYTES) {
    throw new Error(`Workflow draft definition is too large (maximum ${MAX_WORKFLOW_DRAFT_BYTES} bytes)`);
  }
}

function encodedDefinition(definition: unknown): string {
  assertWorkflowDraftDefinitionLimits(definition);
  const json = encode(definition);
  return json;
}

function encodedRunInput(value: unknown): string {
  const json = encode(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_PROPOSED_RUN_INPUT_BYTES) {
    throw new Error(`Proposed run input is too large (maximum ${MAX_PROPOSED_RUN_INPUT_BYTES} bytes)`);
  }
  return json;
}

export class WorkflowDraftStore {
  constructor(
    private readonly core: LedgerCore,
    private readonly workflows: WorkflowRunStore,
  ) {}

  create(input: CreateWorkflowDraftInput): WorkflowDraftRecord {
    const timestamp = input.createdAt ?? nowIso();
    parseTimestamp(timestamp, 'Workflow draft createdAt');
    const workflowId = requireSafeLocalIdentifier(input.workflowId, 'Workflow id');
    const baseRevision = input.baseRevisionId
      ? this.workflows.getWorkflowRevision(input.baseRevisionId)
      : undefined;
    if (input.baseRevisionId && !baseRevision) {
      throw new Error(`Unknown workflow revision: ${input.baseRevisionId}`);
    }
    if (baseRevision && baseRevision.workflowId !== workflowId) {
      throw new Error('Workflow draft base revision belongs to a different workflow');
    }
    const definition = normalizeWorkflowDraftDefinition(
      workflowId,
      workflowDraftRevision(input.definition),
      input.definition,
    );
    const record: WorkflowDraftRecord = {
      id: requireSafeLocalIdentifier(input.id ?? randomUUID(), 'Workflow draft id'),
      workflowId,
      version: 1,
      definition,
      ...(Object.hasOwn(input, 'proposedRunInput')
        ? { proposedRunInput: input.proposedRunInput } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.baseRevisionId ? { baseRevisionId: input.baseRevisionId } : {}),
    };
    this.core.db.prepare(`
      INSERT INTO workflow_drafts(
        id, workflow_id, version, definition_json, proposed_run_input_json,
        base_revision_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.workflowId, record.version, encodedDefinition(record.definition),
      Object.hasOwn(record, 'proposedRunInput')
        ? encodedRunInput(record.proposedRunInput) : null,
      record.baseRevisionId ?? null, record.createdAt, record.updatedAt,
    );
    return record;
  }

  get(id: string): WorkflowDraftRecord | undefined {
    const row = one(this.core.db.prepare('SELECT * FROM workflow_drafts WHERE id = ?'), id);
    return row ? mapDraft(row) : undefined;
  }

  list(workflowId?: string): WorkflowDraftRecord[] {
    const rows = workflowId
      ? many(this.core.db.prepare(`
        SELECT * FROM workflow_drafts WHERE workflow_id = ?
        ORDER BY updated_at DESC, id DESC
      `), workflowId)
      : many(this.core.db.prepare(`
        SELECT * FROM workflow_drafts ORDER BY updated_at DESC, id DESC
      `));
    return rows.map(mapDraft);
  }

  update(input: UpdateWorkflowDraftInput): WorkflowDraftRecord {
    const current = this.requireVersion(input.id, input.expectedVersion);
    if (current.publishedRevisionId) {
      throw new Error(`Workflow draft ${current.id} is published; fork it before editing`);
    }
    const definition = normalizeWorkflowDraftDefinition(
      current.workflowId,
      workflowDraftRevision(current.definition),
      input.definition,
    );
    const timestamp = input.updatedAt ?? nowIso();
    parseTimestamp(timestamp, 'Workflow draft updatedAt');
    const changesRunInput = Object.hasOwn(input, 'proposedRunInput');
    const result = this.core.db.prepare(`
      UPDATE workflow_drafts
      SET definition_json = ?, version = version + 1, updated_at = ?,
          proposed_run_input_json = CASE WHEN ? = 1 THEN ? ELSE proposed_run_input_json END,
          published_revision_id = NULL
      WHERE id = ? AND version = ?
    `).run(
      encodedDefinition(definition), timestamp, changesRunInput ? 1 : 0,
      changesRunInput ? encodedRunInput(input.proposedRunInput) : null,
      input.id, input.expectedVersion,
    );
    if (Number(result.changes) === 0) this.throwMissingOrConflict(input.id, input.expectedVersion);
    return this.get(input.id)!;
  }

  publish(input: PublishWorkflowDraftInput): PublishedWorkflowDraft {
    return this.core.transaction(() => this.publishInTransaction(input));
  }

  publishAndStart(
    input: PublishAndStartWorkflowDraftInput,
  ): PublishedAndStartedWorkflowDraft {
    return this.core.transaction(() => {
      const current = this.requirePublishVersion(input.id, input.expectedVersion);
      if (current.publishedRevisionId && !this.workflows.getRun(input.run.id)) {
        throw new Error(
          `Workflow draft ${current.id} was published without run key ${input.run.id}`,
        );
      }
      const published = this.publishInTransaction(input);
      const launch = this.workflows.createStartedRunIdempotentlyInTransaction({
        ...input.run,
        workflowRevisionId: published.workflowRevision.id,
      }, {
        workflowRevisionId: published.workflowRevision.id,
        workflowId: published.workflowRevision.workflowId,
      });
      return {
        ...published,
        startedRun: launch.startedRun,
        runCreated: launch.created,
      };
    });
  }

  private publishInTransaction(input: PublishWorkflowDraftInput): PublishedWorkflowDraft {
    const draft = this.requirePublishVersion(input.id, input.expectedVersion);
    if (draft.publishedRevisionId) {
      const existing = this.workflows.getWorkflowRevision(draft.publishedRevisionId);
      if (!existing) throw new Error(`Unknown workflow revision: ${draft.publishedRevisionId}`);
      return { draft, workflowRevision: existing };
    }

    const definition = normalizeWorkflowDraftDefinition(
      draft.workflowId,
      this.nextLogicalRevision(draft.workflowId),
      draft.definition,
    );
    const validation = validateLocalWorkflowRevision(definition);
    if (!validation.valid) throw new WorkflowDraftValidationError(draft.id, validation);

    const timestamp = input.publishedAt ?? nowIso();
    parseTimestamp(timestamp, 'Workflow draft publishedAt');
    const workflowRevision = this.workflows.recordWorkflowRevision({
      workflowId: draft.workflowId,
      definition: asWorkflowRevision(definition),
      createdAt: timestamp,
    });
    this.core.db.prepare(`
      UPDATE workflow_drafts
      SET definition_json = ?, version = version + 1, updated_at = ?,
          published_revision_id = ?
      WHERE id = ? AND version = ?
    `).run(
      encodedDefinition(definition), timestamp, workflowRevision.id, draft.id, input.expectedVersion,
    );
    return { draft: this.get(draft.id)!, workflowRevision };
  }

  private nextLogicalRevision(workflowId: string): number {
    let greatest = 0;
    for (const record of this.workflows.listWorkflowRevisions(workflowId)) {
      const definition = record.definition as { revision?: unknown } | null;
      const revision = definition && typeof definition.revision === 'number'
        && Number.isInteger(definition.revision) && definition.revision > 0
        ? definition.revision
        : 0;
      greatest = Math.max(greatest, revision);
    }
    return greatest + 1;
  }

  private requireVersion(id: string, expectedVersion: number): WorkflowDraftRecord {
    const draft = this.get(id);
    if (!draft) throw new Error(`Unknown workflow draft: ${id}`);
    if (draft.version !== expectedVersion) {
      throw new WorkflowDraftVersionConflictError(id, expectedVersion, draft.version);
    }
    return draft;
  }

  private requirePublishVersion(id: string, expectedVersion: number): WorkflowDraftRecord {
    const draft = this.get(id);
    if (!draft) throw new Error(`Unknown workflow draft: ${id}`);
    const lostSuccessRetry = draft.publishedRevisionId
      && expectedVersion === draft.version - 1;
    if (draft.version !== expectedVersion && !lostSuccessRetry) {
      throw new WorkflowDraftVersionConflictError(id, expectedVersion, draft.version);
    }
    return draft;
  }

  private throwMissingOrConflict(id: string, expectedVersion: number): never {
    this.requireVersion(id, expectedVersion);
    throw new Error(`Workflow draft ${id} could not be updated`);
  }
}
