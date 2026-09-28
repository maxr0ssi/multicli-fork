import type { LocalControlPlane } from '../../controlPlane/controlPlane.js';
import type {
  DurableRunEvent,
  DurableRunRecord,
  WorkflowRevisionRecord,
} from '../../persistence/runLedger.js';
import { validateWorkflowRevision } from '../../workflows/graph.js';
import { projectWorkflowRun } from '../../workflows/runProjection.js';
import type { WorkflowRevision } from '../../workflows/domain.js';
import type {
  StudioActionAvailability,
  StudioArtifactPreview,
  StudioBootstrap,
  StudioRunView,
  StudioWorkflowRevision,
  StudioWorkflowSummary,
} from '../contracts/studio.js';
import { STUDIO_CONTRACT_VERSION } from '../contracts/studio.js';
import { StudioArtifactReader } from './artifactReader.js';
import { canonicalWorkspace } from '../../utils/canonicalWorkspace.js';
import {
  asWorkflowRevision,
  object,
  projectApproval,
  projectArtifactSummaries,
  projectGoalSession,
  projectHarness,
  projectNodeExecutions,
  projectRunSummary,
  projectWorkflow,
  projectWorkflowSummary,
} from './studioProjectors.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function allowed(condition: boolean, reason: string): StudioActionAvailability {
  return condition ? { allowed: true } : { allowed: false, reason };
}

function failureReason(events: readonly DurableRunEvent[], fallback?: string): string | undefined {
  const failed = [...events].reverse().find(event => event.type === 'run.failed');
  const reason = object(failed?.payload)?.reason;
  return typeof reason === 'string' && reason.trim() ? reason : fallback;
}

export interface StudioQueryServiceOptions {
  controlPlane: LocalControlPlane;
  workspace: string;
  artifactRoot?: string;
  goalSessionsEnabled?: boolean;
  now?: () => Date;
  artifactPreviewBytes?: number;
  maxArtifactBytes?: number;
}

/** Typed, presentation-neutral query facade for the local Studio client. */
export class StudioQueryService {
  readonly #artifactReader?: StudioArtifactReader;
  readonly #now: () => Date;
  readonly #workspace: string;

  constructor(private readonly options: StudioQueryServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#workspace = canonicalWorkspace(options.workspace);
    this.#artifactReader = options.artifactRoot
      ? new StudioArtifactReader({
        ledger: options.controlPlane.ledger,
        artifactRoot: options.artifactRoot,
        previewBytes: options.artifactPreviewBytes,
        maxArtifactBytes: options.maxArtifactBytes,
      })
      : undefined;
  }

  bootstrap(limit = 100): StudioBootstrap {
    const serverTime = this.#now().toISOString();
    const workflowEntries = this.validWorkflowEntries();
    const workflowsById = new Map(workflowEntries.map(entry => [entry.record.id, entry]));
    const requestedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.trunc(limit), 1_000))
      : 100;
    const runs = this.options.controlPlane.listRuns(1_000).flatMap(run => {
      const entry = workflowsById.get(run.workflowRevisionId);
      if (!entry) return [];
      const semantic = projectWorkflowRun({
        revision: entry.definition,
        runId: run.id,
        createdAt: run.createdAt,
        events: this.listAllEvents(run),
      });
      return [projectRunSummary(run, entry.record, semantic)];
    }).slice(0, requestedLimit);
    const visibleRunIds = new Set(runs.map(run => run.id));
    return {
      schemaVersion: STUDIO_CONTRACT_VERSION,
      serverTime,
      workspace: this.options.workspace,
      runs,
      workflows: workflowEntries.map(entry => projectWorkflowSummary(entry.record)),
      pendingApprovalCount: this.options.controlPlane.ledger.listPendingApprovals()
        .filter(approval => visibleRunIds.has(approval.runId)).length,
      capabilities: {
        goalSessions: this.options.goalSessionsEnabled ?? false,
        inFlightSteering: false,
        artifactPreview: Boolean(this.#artifactReader),
      },
    };
  }

  listWorkflows(): StudioWorkflowSummary[] {
    return this.validWorkflowEntries().map(entry => projectWorkflowSummary(entry.record));
  }

  getWorkflow(revisionId: string): StudioWorkflowRevision {
    const record = this.requireWorkflow(revisionId);
    this.validatedDefinition(record);
    return projectWorkflow(record);
  }

  getRunView(runId: string): StudioRunView {
    const run = this.options.controlPlane.ledger.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const workflowRecord = this.requireWorkflow(run.workflowRevisionId);
    const revision = this.validatedDefinition(workflowRecord);
    const events = this.listAllEvents(run);
    const semantic = projectWorkflowRun({
      revision,
      runId,
      createdAt: run.createdAt,
      events,
    });
    const ledger = this.options.controlPlane.ledger;
    const durableAttempts = ledger.listNodeAttempts(runId);
    const artifactRecords = ledger.listArtifacts(runId);
    const approvalRecords = ledger.listApprovals(runId);
    const serverTime = this.#now().toISOString();
    const artifacts = projectArtifactSummaries(artifactRecords, this.#artifactReader);
    const harness = projectHarness(events);
    const execution = projectNodeExecutions({
      run,
      semantic,
      attempts: durableAttempts,
      artifacts: artifactRecords,
      approvals: approvalRecords,
      serverTime,
    });
    const lastEventSequence = events.at(-1)?.sequence ?? 0;
    if (lastEventSequence !== run.lastSequence) {
      execution.issues.push(
        `Run sequence is ${run.lastSequence}, but only events through ${lastEventSequence} were read.`,
      );
    }
    const mutable = !TERMINAL_RUN_STATUSES.has(run.status);
    const pendingApproval = approvalRecords.some(approval => approval.status === 'pending');
    const workspaceIssue = !run.workspace
      ? 'This legacy run has no pinned workspace and is observer-only'
      : run.workspace !== this.#workspace
        ? 'This run belongs to a different workspace and is observer-only here'
        : undefined;
    if (workspaceIssue) execution.issues.push(workspaceIssue);
    const scoped = !workspaceIssue;
    const summary = projectRunSummary(run, workflowRecord, semantic);
    return {
      schemaVersion: STUDIO_CONTRACT_VERSION,
      serverTime,
      run: {
        ...summary,
        input: run.input,
        allowedActions: {
          pause: allowed(
            scoped && run.status === 'running' && !pendingApproval,
            workspaceIssue ?? (pendingApproval
              ? 'This workflow is waiting for an approval decision'
              : 'Only a running workflow can be paused'),
          ),
          resume: allowed(
            scoped && run.status === 'waiting' && !pendingApproval,
            workspaceIssue ?? (pendingApproval
              ? 'Resolve the pending approval before the workflow can continue'
              : 'Only a paused workflow can be resumed'),
          ),
          cancel: allowed(scoped && mutable, workspaceIssue ?? 'Terminal workflows cannot be cancelled'),
          openGoalSession: allowed(
            scoped && Boolean(this.options.goalSessionsEnabled),
            workspaceIssue ?? 'Goal sessions are not configured for this Studio server',
          ),
        },
      },
      workflow: projectWorkflow(workflowRecord),
      execution: {
        status: run.status,
        ...(failureReason(events, semantic.failureReason)
          ? { failureReason: failureReason(events, semantic.failureReason) }
          : {}),
        budget: semantic.budget,
        nodes: execution.nodes,
        integrity: {
          state: execution.issues.length ? 'degraded' : 'ok',
          issues: execution.issues,
        },
      },
      events,
      artifacts,
      approvals: approvalRecords.map(approval => projectApproval({
        approval,
        runMutable: mutable,
        serverTime,
      })),
      harness,
      goalSessions: ledger.listGoalSessions(runId).map(session => (
        projectGoalSession(
          session,
          ledger.listGoalSessionArtifacts(session.id),
          serverTime,
          this.options.goalSessionsEnabled ?? false,
        )
      )),
    };
  }

  getArtifactPreview(runId: string, artifactId: string): StudioArtifactPreview {
    if (!this.#artifactReader) throw new Error('Artifact preview is not configured');
    return this.#artifactReader.preview(runId, artifactId);
  }

  private requireWorkflow(id: string): WorkflowRevisionRecord {
    const workflow = this.options.controlPlane.ledger.getWorkflowRevision(id);
    if (!workflow) throw new Error(`Unknown workflow revision: ${id}`);
    return workflow;
  }

  private validatedDefinition(record: WorkflowRevisionRecord) {
    const definition = asWorkflowRevision(record);
    const validation = validateWorkflowRevision(definition);
    if (!validation.valid) {
      throw new Error(
        `Invalid workflow revision: ${validation.issues.map(issue => issue.message).join(' ')}`,
      );
    }
    return definition;
  }

  private optionalDefinition(record: WorkflowRevisionRecord): WorkflowRevision | undefined {
    const definition = asWorkflowRevision(record);
    return validateWorkflowRevision(definition).valid ? definition : undefined;
  }

  private validWorkflowEntries(): Array<{
    record: WorkflowRevisionRecord;
    definition: WorkflowRevision;
  }> {
    return this.options.controlPlane.ledger.listWorkflowRevisions().flatMap(record => {
      const definition = this.optionalDefinition(record);
      return definition ? [{ record, definition }] : [];
    });
  }

  private listAllEvents(run: DurableRunRecord): DurableRunEvent[] {
    const events: DurableRunEvent[] = [];
    let after = 0;
    while (after < run.lastSequence) {
      const page = this.options.controlPlane.ledger.listEvents(run.id, after, 10_000);
      if (!page.length) break;
      events.push(...page);
      after = page.at(-1)!.sequence;
    }
    return events;
  }
}
