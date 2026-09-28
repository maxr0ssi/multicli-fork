import type { LocalControlPlane } from '../controlPlane/controlPlane.js';
import type { ApprovalRecord } from '../persistence/runLedger.js';
import { runRepositoryHarness, type RepositoryHarnessReport } from '../harness/repository.js';
import type { AgentNode, GateNode, WorkflowRevision } from './domain.js';
import { validateWorkflowRevision } from './graph.js';
import type { WorkflowProviderExecutor } from './executor.js';
import { createWorkflowGateApproval } from './approvalEvidence.js';
import { assertWorkflowConcurrency, DEFAULT_WORKFLOW_CONCURRENCY } from './agentCaps.js';
import { projectWorkflowRun } from './runProjection.js';
import { RunnerAuthorityLease } from './runnerAuthority.js';
import { RunnerAgentSemaphore, WorkspaceWriterLock } from './workspaceWriterLock.js';
import { WorkflowNodeExecutor } from './workflowNodeExecutor.js';
import { waitForAttemptRecovery } from './runnerRecovery.js';
import {
  hasRunningProviderAttempt,
  providerCallAdmission,
} from './budgetAdmission.js';
import { reconcilePendingProviderTermination } from './runnerReconciliation.js';
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function isTerminalDurableRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export class LocalWorkflowRunner {
  readonly #active = new Map<string, Promise<void>>();
  readonly #controllers = new Map<string, AbortController>();
  #closed = false;
  #closing: Promise<void> | undefined;
  readonly #maxConcurrentAgents: number;
  readonly #authority: RunnerAuthorityLease;
  readonly #writerLock = new WorkspaceWriterLock();
  readonly #agentSlots: RunnerAgentSemaphore;
  readonly #nodeExecutor: WorkflowNodeExecutor;

  constructor(
    private readonly options: {
      controlPlane: LocalControlPlane;
      executor: WorkflowProviderExecutor;
      workspace: string;
      artifactRoot: string;
      leaseMs?: number;
      authorityLeaseMs?: number;
      maxConcurrentAgents?: number;
      runHarness?: (workspace: string) => Promise<RepositoryHarnessReport>;
    },
  ) {
    this.#maxConcurrentAgents = assertWorkflowConcurrency(
      options.maxConcurrentAgents ?? DEFAULT_WORKFLOW_CONCURRENCY,
    );
    this.#agentSlots = new RunnerAgentSemaphore(this.#maxConcurrentAgents);
    this.#authority = new RunnerAuthorityLease({
      ledger: options.controlPlane.ledger,
      workspace: options.workspace,
      leaseMs: options.authorityLeaseMs,
      onLost: error => {
        for (const controller of this.#controllers.values()) {
          controller.abort(error instanceof Error
            ? error
            : new Error('Workflow runner lost durable execution authority'));
        }
      },
    });
    this.#nodeExecutor = new WorkflowNodeExecutor({
      controlPlane: options.controlPlane,
      executor: options.executor,
      workspace: this.#authority.workspace,
      artifactRoot: options.artifactRoot,
      leaseMs: options.leaseMs,
      renewAuthority: () => this.#authority.renew(),
    });
  }

  execute(runId: string): Promise<void> {
    const existing = this.#active.get(runId);
    if (existing) return existing;
    if (this.#closed) {
      return Promise.reject(new Error('Workflow runner is closed.'));
    }
    const run = this.options.controlPlane.ledger.getRun(runId);
    if (!run) return Promise.reject(new Error(`Unknown run: ${runId}`));
    if (!run.workspace) {
      return Promise.reject(new Error(
        `Run ${runId} has no pinned workspace and is observer-only; start a new run to execute it.`,
      ));
    }
    if (run.workspace !== this.#authority.workspace) {
      return Promise.reject(new Error(
        `Run ${runId} belongs to ${run.workspace}; this runner is pinned to ${this.#authority.workspace}.`,
      ));
    }
    if (isTerminalDurableRunStatus(run.status)) return Promise.resolve();
    const controller = new AbortController();
    this.#controllers.set(runId, controller);
    const work = (async () => {
      if (!await this.#authority.acquire(controller.signal)) return;
      this.options.controlPlane.recoverExpiredNodeAttempts(
        undefined,
        this.#authority.workspace,
      );
      await this.#drive(runId, controller.signal);
    })().finally(() => {
      this.#active.delete(runId);
      this.#controllers.delete(runId);
      if (this.#active.size === 0) this.#authority.release();
    });
    this.#active.set(runId, work);
    return work;
  }

  stop(runId: string, reason = 'Run stopped by local control'): void {
    this.#controllers.get(runId)?.abort(new Error(reason));
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const active = [...this.#active.values()];
    for (const [runId, controller] of this.#controllers) {
      controller.abort(new Error(`Workflow runner closed: ${runId}`));
    }
    this.#closing = Promise.allSettled(active).then(() => {
      this.#authority.release();
    });
    return this.#closing;
  }

  async recover(): Promise<void> {
    if (this.#closed) return;
    const resumable = this.options.controlPlane.listRuns(1_000)
      .filter(run => (
        run.status === 'running'
        && run.workspace === this.#authority.workspace
      ));
    await Promise.all(resumable.map(run => this.execute(run.id)));
  }

  async resolveGateApproval(approval: ApprovalRecord): Promise<void> {
    const persisted = this.options.controlPlane.ledger.getApproval(approval.id);
    if (
      !persisted
      || persisted.runId !== approval.runId
      || persisted.status !== approval.status
      || (persisted.status !== 'approved' && persisted.status !== 'denied')
    ) return;
    const run = this.options.controlPlane.ledger.getRun(persisted.runId);
    if (!run || run.workspace !== this.#authority.workspace) return;
    const payload = asRecord(persisted.payload);
    if (payload?.kind !== 'workflow-gate') return;
    const nodeId = asString(payload.nodeId);
    if (!nodeId) return;
    const snapshot = this.options.controlPlane.getRunSnapshot(persisted.runId);
    if (isTerminalDurableRunStatus(snapshot.run.status)) return;
    const revision = snapshot.workflowRevision.definition as WorkflowRevision;
    if (!validateWorkflowRevision(revision).valid) return;
    const state = projectWorkflowRun({
      revision,
      runId: persisted.runId,
      createdAt: snapshot.run.createdAt,
      events: snapshot.events,
    });
    if (
      state.status !== 'running'
      || state.nodeStates[nodeId]?.status !== 'waiting_for_gate'
    ) return;
    if (!this.#appendEventIfMutable(persisted.runId, 'gate.resolved', {
      nodeId,
      decision: persisted.status === 'approved' ? 'approved' : 'rejected',
      note: `Resolved by ${persisted.decisionBy ?? 'local operator'}`,
    }, {
      expectedSequence: snapshot.run.lastSequence,
      idempotencyKey: `gate:${persisted.id}:resolved`,
    })) return;

    const current = this.options.controlPlane.ledger.getRun(persisted.runId);
    if (!current || isTerminalDurableRunStatus(current.status)) return;
    if (persisted.status === 'denied') {
      this.#appendEventIfMutable(persisted.runId, 'run.failed', {
        reason: 'Workflow review gate was denied',
        nodeId,
      });
      return;
    }
    if (persisted.status === 'approved' && current.status === 'waiting') {
      try {
        this.options.controlPlane.resumeRun(persisted.runId);
      } catch (error) {
        if (!this.#isRunMutable(persisted.runId)) return;
        throw error;
      }
    }
    await this.execute(persisted.runId);
  }

  #isRunMutable(runId: string): boolean {
    const run = this.options.controlPlane.ledger.getRun(runId);
    return Boolean(run && !isTerminalDurableRunStatus(run.status));
  }

  #appendEventIfMutable(
    runId: string,
    type: string,
    payload: unknown,
    options: { expectedSequence?: number; idempotencyKey?: string } = {},
  ): boolean {
    if (!this.#isRunMutable(runId)) return false;
    try {
      this.options.controlPlane.appendEvent(runId, type, payload, options);
      return true;
    } catch (error) {
      if (!this.#isRunMutable(runId)) return false;
      throw error;
    }
  }

  #requestApprovalIfMutable(input: {
    runId: string;
    actionHash: string;
    risk: string;
    payload: unknown;
  }): boolean {
    if (!this.#isRunMutable(input.runId)) return false;
    try {
      this.options.controlPlane.requestApproval(input);
      return true;
    } catch (error) {
      if (!this.#isRunMutable(input.runId)) return false;
      throw error;
    }
  }

  async #drive(runId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const snapshot = this.options.controlPlane.getRunSnapshot(runId);
      if (['completed', 'failed', 'cancelled'].includes(snapshot.run.status)) return;
      // Pause is a graceful scheduling boundary: an already leased activity may
      // finish, but no additional provider invocation starts until resume.
      // This avoids aborting a workspace writer and then unsafely replaying it.
      if (snapshot.run.status === 'waiting') return;
      const revision = snapshot.workflowRevision.definition as WorkflowRevision;
      const validation = validateWorkflowRevision(revision);
      if (!validation.valid) {
        this.#appendEventIfMutable(runId, 'run.failed', {
          reason: validation.issues.map(issue => issue.message).join(' '),
        });
        return;
      }
      const state = projectWorkflowRun({
        revision,
        runId,
        createdAt: snapshot.run.createdAt,
        events: snapshot.events,
      });
      const reconciliation = await reconcilePendingProviderTermination({
        controlPlane: this.options.controlPlane, runId, state, signal,
        workspace: this.#authority.workspace,
        appendEvent: (type, payload, eventOptions) => (
          this.#appendEventIfMutable(runId, type, payload, eventOptions)
        ),
      });
      if (reconciliation === 'continue') continue;
      if (reconciliation === 'stop') return;
      if (state.status === 'succeeded') {
        this.#appendEventIfMutable(runId, 'run.completed', { workflow: revision.id });
        return;
      }
      if (state.status === 'failed' || state.status === 'budget_exhausted') {
        this.#appendEventIfMutable(runId, 'run.failed', {
          reason: state.failureReason ?? state.status,
        }, { idempotencyKey: 'run:failed:semantic' });
        return;
      }
      if (state.status === 'cancelled') return;

      const gate = revision.nodes.find((node): node is GateNode => (
        node.kind === 'gate'
        && state.nodeStates[node.id]?.status === 'waiting_for_gate'
      ));
      if (gate) {
        const requiresHarness = revision.metadata?.harness === 'repository';
        const priorHarness = snapshot.events.find(event => (
          event.type === 'harness.completed'
          && asRecord(event.payload)?.gateId === gate.id
        ));
        if (requiresHarness && !priorHarness) {
          if (!this.#appendEventIfMutable(runId, 'harness.started', {
            gateId: gate.id,
            trigger: 'node_exit',
          })) return;
          const report = await (this.options.runHarness
            ?? (workspace => runRepositoryHarness({ workspace, trigger: 'node_exit' })))(
            this.#authority.workspace,
          );
          if (!this.#appendEventIfMutable(runId, 'harness.completed', {
            gateId: gate.id,
            invocationId: report.result.invocationId,
            outcome: report.result.outcome,
            checks: report.checks,
            findingCount: report.result.unwaivedFindings.length,
          })) return;
          if (report.result.outcome === 'block' || report.result.outcome === 'error') {
            this.#appendEventIfMutable(runId, 'run.failed', {
              reason: 'Repository harness blocked the review gate',
            });
            return;
          }
        }
        const reviewSnapshot = this.options.controlPlane.getRunSnapshot(runId);
        const pending = reviewSnapshot.approvals.some(approval => (
          asRecord(approval.payload)?.nodeId === gate.id
        ));
        if (!pending) {
          const approval = createWorkflowGateApproval(reviewSnapshot, gate);
          if (!this.#requestApprovalIfMutable({
            runId,
            actionHash: approval.actionHash,
            risk: 'workflow-completion',
            payload: approval.payload,
          })) return;
          this.#appendEventIfMutable(runId, 'run.waiting', {
            reason: 'manual workflow gate',
            nodeId: gate.id,
          });
        }
        return;
      }

      const ready = revision.nodes.filter((node): node is AgentNode => (
        node.kind === 'agent' && state.nodeStates[node.id]?.status === 'ready'
      ));
      if (!ready.length) {
        if (await waitForAttemptRecovery({
          controlPlane: this.options.controlPlane, runId,
          workspace: this.#authority.workspace, signal,
        })) continue;
        return;
      }
      const readOnly = ready.filter(node => {
        const profile = revision.profiles.find(candidate => candidate.id === node.profileId);
        return profile?.workspaceAccess === 'read-only';
      });
      const writers = ready.filter(node => !readOnly.includes(node));
      if (readOnly.length > 0) {
        const requested = Math.min(readOnly.length, this.#maxConcurrentAgents);
        const admission = providerCallAdmission(state, requested);
        if (admission.capacity === 0) {
          if (admission.exhaustedReason && !hasRunningProviderAttempt(state)) {
            this.#appendEventIfMutable(runId, 'run.budget_exhausted', {
              reason: admission.exhaustedReason,
            }, { idempotencyKey: 'run:budget-exhausted:admission' });
          }
          return;
        }
        await Promise.all(readOnly
          .slice(0, admission.capacity)
          .map(node => this.#agentSlots.run(async () => {
            if (!signal.aborted) {
              await this.#nodeExecutor.execute({ runId, revision, node, state, signal });
            }
          })));
        continue;
      }
      const admission = providerCallAdmission(state, writers.length);
      if (admission.capacity === 0) {
        if (admission.exhaustedReason && !hasRunningProviderAttempt(state)) {
          this.#appendEventIfMutable(runId, 'run.budget_exhausted', {
            reason: admission.exhaustedReason,
          }, { idempotencyKey: 'run:budget-exhausted:admission' });
        }
        return;
      }
      for (const node of writers.slice(0, admission.capacity)) {
        if (signal.aborted) return;
        const currentRun = this.options.controlPlane.ledger.getRun(runId);
        if (!currentRun || currentRun.status !== 'running') return;
        await this.#writerLock.run(async () => {
          await this.#agentSlots.run(async () => {
            if (!signal.aborted) {
              await this.#nodeExecutor.execute({ runId, revision, node, state, signal });
            }
          });
        });
      }
    }
  }
}
