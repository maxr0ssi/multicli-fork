import path from 'node:path';

import {
  LocalControlPlane,
  type RunEventListener,
  type RunSnapshot,
} from './controlPlane/controlPlane.js';
import type { Logger } from './logger.js';
import {
  SqliteRunLedger,
  type ApprovalRecord,
  type RunLedger,
  type WorkflowRevisionRecord,
} from './persistence/runLedger.js';
import type { RepositoryHarnessReport } from './harness/repository.js';
import type { WorkflowRevision } from './workflows/domain.js';
import {
  LocalSubscriptionCliExecutor,
  type WorkflowProviderExecutor,
} from './workflows/executor.js';
import { validateWorkflowRevision } from './workflows/graph.js';
import {
  GoalSessionService,
  type OpenGoalSessionInput,
  type PersistentGoalSession,
} from './workflows/goalSession.js';
import { LocalWorkflowRunner } from './workflows/runner.js';

export type LocalWorkflowReference =
  | WorkflowRevision
  | WorkflowRevisionRecord
  | string;

export interface ExistingLocalRun {
  runId: string;
}

export interface LocalRunOptions {
  runId?: string;
  parentRunId?: string;
}

export interface LocalApprovalDecision {
  approvalId: string;
  actionHash: string;
  decisionBy: string;
}

/** The local runtime supplies its workspace when a goal-specific cwd is omitted. */
export type OpenLocalGoalInput = Omit<OpenGoalSessionInput, 'cwd'> & {
  cwd?: string;
};

/** The narrow runner contract makes the facade easy to embed and unit test. */
export interface LocalOrchestratorRunner {
  execute(runId: string): Promise<void>;
  stop(runId: string, reason?: string): void;
  close(): Promise<void>;
  recover(): Promise<void>;
  resolveGateApproval(approval: ApprovalRecord): Promise<void>;
}

export interface LocalOrchestratorDependencies {
  controlPlane: LocalControlPlane;
  runner: LocalOrchestratorRunner;
  goalSessions?: GoalSessionService;
  goalCwd?: string;
  /** Defaults to false so an embedding application retains dependency ownership. */
  ownsControlPlane?: boolean;
}

export interface CreateLocalOrchestratorOptions {
  workspace: string;
  /** Defaults to `<workspace>/.multicli/runs.sqlite`. */
  storePath?: string;
  /** Defaults beside the durable store, under `artifacts/`. */
  artifactRoot?: string;
  executor?: WorkflowProviderExecutor;
  ledger?: RunLedger;
  logger?: Logger;
  /** @deprecated Use maxRuntimeMs to make the wall-clock semantics explicit. */
  timeoutMs?: number;
  /** Optional last-resort wall-clock ceiling. Omitted by default. */
  maxRuntimeMs?: number;
  killGraceMs?: number;
  leaseMs?: number;
  /** Defaults to five active read-only workflow nodes, with a hard ceiling of twenty. */
  maxConcurrentAgents?: number;
  goalTurnLeaseMs?: number;
  runHarness?: (workspace: string) => Promise<RepositoryHarnessReport>;
}

function isRecordedRevision(
  value: WorkflowRevision | WorkflowRevisionRecord,
): value is WorkflowRevisionRecord {
  return 'workflowId' in value
    && 'definition' in value
    && 'contentHash' in value;
}

function isExistingRun(value: unknown): value is ExistingLocalRun {
  return Boolean(
    value
    && typeof value === 'object'
    && 'runId' in value
    && typeof (value as ExistingLocalRun).runId === 'string',
  );
}

function assertWorkflowRevision(value: unknown): asserts value is WorkflowRevision {
  if (
    !value
    || typeof value !== 'object'
    || !Array.isArray((value as Partial<WorkflowRevision>).profiles)
    || !Array.isArray((value as Partial<WorkflowRevision>).nodes)
    || !Array.isArray((value as Partial<WorkflowRevision>).edges)
  ) {
    throw new Error('Invalid workflow revision: profiles, nodes, and edges are required.');
  }
  const validation = validateWorkflowRevision(value as WorkflowRevision);
  if (!validation.valid) {
    throw new Error(
      `Invalid workflow revision: ${validation.issues.map(issue => issue.message).join(' ')}`,
    );
  }
}

/**
 * Side-effect-free, importable facade over the durable local workflow kernel.
 * Construction is explicit; importing this module never starts stdio or HTTP.
 */
export class LocalOrchestrator {
  readonly controlPlane: LocalControlPlane;
  readonly runner: LocalOrchestratorRunner;
  readonly goalSessions?: GoalSessionService;
  readonly #ownsControlPlane: boolean;
  readonly #goalCwd?: string;
  readonly #workspace: string;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(dependencies: LocalOrchestratorDependencies) {
    this.controlPlane = dependencies.controlPlane;
    this.runner = dependencies.runner;
    this.goalSessions = dependencies.goalSessions;
    this.#goalCwd = dependencies.goalCwd;
    this.#workspace = path.resolve(dependencies.goalCwd ?? process.cwd());
    this.#ownsControlPlane = dependencies.ownsControlPlane ?? false;
  }

  get closed(): boolean {
    return this.#closed;
  }

  publish(reference: LocalWorkflowReference): WorkflowRevisionRecord {
    this.#assertOpen();
    if (typeof reference === 'string') {
      const revision = this.controlPlane.ledger.getWorkflowRevision(reference);
      if (!revision) throw new Error(`Unknown workflow revision: ${reference}`);
      return revision;
    }

    if (isRecordedRevision(reference)) {
      assertWorkflowRevision(reference.definition);
      const existing = this.controlPlane.ledger.getWorkflowRevision(reference.id);
      if (existing) {
        if (existing.contentHash !== reference.contentHash) {
          throw new Error(`Workflow revision ${reference.id} has conflicting content`);
        }
        return existing;
      }
      return this.controlPlane.publishWorkflow({
        id: reference.id,
        workflowId: reference.workflowId,
        definition: reference.definition,
      });
    }

    assertWorkflowRevision(reference);
    return this.controlPlane.publishWorkflow({
      workflowId: reference.id,
      definition: reference,
    });
  }

  start(
    workflow: LocalWorkflowReference,
    input?: unknown,
    options: LocalRunOptions = {},
  ): RunSnapshot {
    this.#assertOpen();
    const revision = this.publish(workflow);
    return this.controlPlane.startRun({
      id: options.runId,
      workflowRevisionId: revision.id,
      workspace: this.#workspace,
      runInput: input,
      parentRunId: options.parentRunId,
    });
  }

  /** Execute a new workflow, or continue an explicitly identified existing run. */
  async run(
    target: LocalWorkflowReference | ExistingLocalRun,
    input?: unknown,
    options: LocalRunOptions = {},
  ): Promise<RunSnapshot> {
    this.#assertOpen();
    const runId = isExistingRun(target)
      ? target.runId
      : this.start(target, input, options).run.id;
    await this.runner.execute(runId);
    return this.get(runId);
  }

  get(runId: string): RunSnapshot {
    this.#assertOpen();
    return this.controlPlane.getRunSnapshot(runId);
  }

  list(limit = 100): RunSnapshot[] {
    this.#assertOpen();
    return this.controlPlane.listRuns(limit)
      .map(run => this.controlPlane.getRunSnapshot(run.id));
  }

  pause(runId: string): RunSnapshot {
    this.#assertOpen();
    return this.controlPlane.pauseRun(runId);
  }

  async resume(runId: string): Promise<RunSnapshot> {
    this.#assertOpen();
    this.controlPlane.resumeRun(runId);
    await this.runner.execute(runId);
    return this.get(runId);
  }

  cancel(runId: string): RunSnapshot {
    this.#assertOpen();
    const snapshot = this.controlPlane.cancelRun(runId);
    this.runner.stop(runId, 'Run cancelled through LocalOrchestrator');
    return snapshot;
  }

  async approve(input: LocalApprovalDecision): Promise<RunSnapshot> {
    return this.#resolveApproval(input, 'approved');
  }

  async deny(input: LocalApprovalDecision): Promise<RunSnapshot> {
    return this.#resolveApproval(input, 'denied');
  }

  subscribe(runId: string | '*', listener: RunEventListener): () => void {
    this.#assertOpen();
    return this.controlPlane.subscribe(runId, listener);
  }

  /** Open a durable, provider-native goal conversation pinned to this runtime. */
  openGoal(input: OpenLocalGoalInput): PersistentGoalSession {
    this.#assertOpen();
    const service = this.#requireGoalSessions();
    const cwd = input.cwd ?? this.#goalCwd;
    if (!cwd) throw new Error('A goal session cwd is required');
    return service.openGoalSession({ ...input, cwd: path.resolve(cwd) });
  }

  getGoal(id: string): PersistentGoalSession | undefined {
    this.#assertOpen();
    return this.#requireGoalSessions().get(id);
  }

  listGoals(runId?: string, limit?: number) {
    this.#assertOpen();
    return this.#requireGoalSessions().list(runId, limit);
  }

  async recover(): Promise<RunSnapshot[]> {
    this.#assertOpen();
    await this.runner.recover();
    return this.list();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      try {
        await this.runner.close();
      } finally {
        if (this.#ownsControlPlane) this.controlPlane.close();
      }
    })();
    return this.#closing;
  }

  async #resolveApproval(
    input: LocalApprovalDecision,
    decision: 'approved' | 'denied',
  ): Promise<RunSnapshot> {
    this.#assertOpen();
    const approval = this.controlPlane.resolveApproval({
      id: input.approvalId,
      decision,
      decisionBy: input.decisionBy,
      actionHash: input.actionHash,
    });
    await this.runner.resolveGateApproval(approval);
    return this.get(approval.runId);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('LocalOrchestrator is closed.');
  }

  #requireGoalSessions(): GoalSessionService {
    if (!this.goalSessions) {
      throw new Error('Goal sessions were not configured for this LocalOrchestrator.');
    }
    return this.goalSessions;
  }
}

export function createLocalOrchestrator(
  options: CreateLocalOrchestratorOptions,
): LocalOrchestrator {
  const workspace = path.resolve(options.workspace);
  const storePath = options.storePath === ':memory:'
    ? ':memory:'
    : options.storePath
    ? path.resolve(options.storePath)
    : path.join(workspace, '.multicli', 'runs.sqlite');
  const artifactRoot = options.artifactRoot
    ? path.resolve(options.artifactRoot)
    : storePath === ':memory:'
      ? path.join(workspace, '.multicli', 'artifacts')
      : path.join(path.dirname(storePath), 'artifacts');
  const ledger = options.ledger ?? new SqliteRunLedger(storePath);
  const controlPlane = new LocalControlPlane(ledger);
  const executor = options.executor ?? new LocalSubscriptionCliExecutor({
    timeoutMs: options.maxRuntimeMs ?? options.timeoutMs,
    killGraceMs: options.killGraceMs ?? 5_000,
    logger: options.logger,
  });
  const runner = new LocalWorkflowRunner({
    controlPlane,
    executor,
    workspace,
    artifactRoot,
    leaseMs: options.leaseMs,
    maxConcurrentAgents: options.maxConcurrentAgents,
    runHarness: options.runHarness,
  });
  const goalSessions = new GoalSessionService({
    store: ledger,
    executor,
    artifactRoot,
    turnLeaseMs: options.goalTurnLeaseMs,
    onRunEvents: (runId, afterSequence) => {
      controlPlane.emitPersistedEvents(runId, afterSequence);
    },
  });
  return new LocalOrchestrator({
    controlPlane,
    runner,
    goalSessions,
    goalCwd: workspace,
    ownsControlPlane: true,
  });
}
