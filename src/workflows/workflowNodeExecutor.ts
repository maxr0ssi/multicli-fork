import { createHash, randomUUID } from 'node:crypto';

import type { LocalControlPlane } from '../controlPlane/controlPlane.js';
import type { DurableNodeAttemptRecord } from '../persistence/runLedger.js';
import { writeWorkflowArtifact } from './artifacts.js';
import type {
  AgentNode,
  AttemptUsage,
  RunRecord,
  WorkflowRevision,
} from './domain.js';
import type { WorkflowProviderExecutor } from './executor.js';
import { ProviderExecutionError } from './providerUsage.js';
import { renderWorkflowRunContext } from './runContext.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function interpolatePrompt(template: string, input: unknown): string {
  const objective = typeof record(input)?.objective === 'string'
    ? String(record(input)!.objective)
    : JSON.stringify(input ?? null);
  return template.replaceAll('{{objective}}', objective);
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export class WorkflowNodeExecutor {
  constructor(private readonly options: {
    controlPlane: LocalControlPlane;
    executor: WorkflowProviderExecutor;
    workspace: string;
    artifactRoot: string;
    leaseMs?: number;
    renewAuthority: () => boolean;
  }) {}

  async execute(input: {
    runId: string;
    revision: WorkflowRevision;
    node: AgentNode;
    state: RunRecord;
    signal: AbortSignal;
  }): Promise<void> {
    if (!this.options.renewAuthority()) return;
    const { runId, revision, node, state, signal } = input;
    const profile = revision.profiles.find(candidate => candidate.id === node.profileId);
    if (!profile) throw new Error(`Missing profile ${node.profileId}`);
    const number = state.nodeStates[node.id].attempts.length + 1;
    const workerId = `local:${process.pid}:${randomUUID()}`;
    const leaseMs = this.options.leaseMs ?? 20 * 60 * 1000;
    let attempt: DurableNodeAttemptRecord | undefined;
    try {
      attempt = this.options.controlPlane.scheduleNodeAttempt({
        runId,
        nodeId: node.id,
        attemptNumber: number,
        idempotencyKey: `${runId}:${node.id}:${number}`,
      });
      const claimed = this.options.controlPlane.claimNodeAttempt({
        id: attempt.id,
        workerId,
        leaseMs,
      });
      if (!claimed) return;
    } catch (error) {
      if (!this.#isRunMutable(runId)) return;
      throw error;
    }

    try {
      if (signal.aborted) {
        this.#completeStopped(runId, attempt.id, workerId, profile.workspaceAccess === 'read-only');
        return;
      }
      const snapshot = this.options.controlPlane.getRunSnapshot(runId);
      if (isTerminal(snapshot.run.status)) return;
      const priorArtifacts = snapshot.artifacts.map(artifact => artifact.location);
      const result = await this.options.executor.execute({
        profile: {
          profileId: profile.id,
          provider: profile.provider,
          model: profile.model,
          reasoningEffort: profile.reasoningEffort,
          workspaceAccess: profile.workspaceAccess,
          selection: profile.selection,
          enableSubagents: profile.enableSubagents ?? false,
        },
        prompt: [
          interpolatePrompt(node.prompt, snapshot.run.input),
          `Run input (exact operator-supplied JSON):\n${renderWorkflowRunContext(snapshot.run.input)}`,
          `Workflow: ${revision.name}`,
          `Node: ${node.label}`,
          `Workspace: ${this.options.workspace}`,
          priorArtifacts.length
            ? `Prior local artifacts (read these instead of asking for transcript replay):\n${priorArtifacts.join('\n')}`
            : 'No prior artifacts are available.',
          'Honor repository instructions and record a concise, verifiable result.',
        ].join('\n\n'),
        cwd: this.options.workspace,
        signal,
        heartbeatMs: Math.max(1_000, Math.min(30_000, Math.floor(leaseMs / 3))),
        onHeartbeat: () => this.options.controlPlane.renewNodeAttemptLease({
          id: attempt!.id,
          workerId,
          leaseMs,
        }),
      });
      if (!this.options.renewAuthority()) return;
      if (signal.aborted) {
        this.#completeStopped(runId, attempt.id, workerId, profile.workspaceAccess === 'read-only');
        return;
      }
      if (!this.#ownedUnexpiredAttempt(runId, attempt.id, workerId)) {
        this.#recoverWorkspaceAttempts();
        return;
      }
      const artifactPath = writeWorkflowArtifact({
        artifactRoot: this.options.artifactRoot,
        runId,
        nodeId: node.id,
        attemptNumber: number,
        text: result.text,
      });
      const artifact = this.options.controlPlane.recordArtifact({
        runId,
        nodeAttemptId: attempt.id,
        contentHash: createHash('sha256').update(result.text).digest('hex'),
        mediaType: 'text/markdown',
        name: `${node.label} result`,
        location: artifactPath,
        metadata: {
          provider: profile.provider,
          model: profile.model,
          reasoningEffort: profile.reasoningEffort,
          enableSubagents: profile.enableSubagents ?? false,
          sessionId: result.sessionId,
        },
      });
      this.#completeOwnedAttempt({
        runId, attemptId: attempt.id, workerId, status: 'succeeded',
        outputArtifactId: artifact.id, usage: result.usage,
      });
    } catch (error) {
      if (!this.options.renewAuthority()) return;
      const providerFailure = error instanceof ProviderExecutionError ? error : undefined;
      this.#completeOwnedAttempt({
        runId,
        attemptId: attempt.id,
        workerId,
        status: 'failed',
        error: signal.aborted
          ? 'Worker stopped before a result was committed.'
          : 'Provider execution failed; inspect local CLI diagnostics.',
        retryable: profile.workspaceAccess === 'read-only',
        usage: providerFailure?.details.usage,
      });
    }
  }

  #isRunMutable(runId: string): boolean {
    const run = this.options.controlPlane.ledger.getRun(runId);
    return Boolean(run && !isTerminal(run.status));
  }

  #ownedUnexpiredAttempt(
    runId: string,
    attemptId: string,
    workerId: string,
  ): DurableNodeAttemptRecord | undefined {
    if (!this.#isRunMutable(runId)) return undefined;
    const attempt = this.options.controlPlane.ledger.getNodeAttempt(attemptId);
    if (!attempt || attempt.status !== 'running' || attempt.leaseOwner !== workerId
      || !attempt.leaseExpiresAt) return undefined;
    const expiresAt = Date.parse(attempt.leaseExpiresAt);
    return Number.isFinite(expiresAt) && expiresAt > Date.now() ? attempt : undefined;
  }

  #completeStopped(
    runId: string,
    attemptId: string,
    workerId: string,
    retryable: boolean,
  ): void {
    this.#completeOwnedAttempt({
      runId, attemptId, workerId, status: 'failed', retryable,
      error: 'Worker stopped before a result was committed.',
    });
  }

  #completeOwnedAttempt(input: {
    runId: string;
    attemptId: string;
    workerId: string;
    status: 'succeeded' | 'failed';
    outputArtifactId?: string;
    error?: string;
    retryable?: boolean;
    usage?: AttemptUsage;
  }): boolean {
    if (!this.#ownedUnexpiredAttempt(input.runId, input.attemptId, input.workerId)) {
      this.#recoverWorkspaceAttempts();
      return false;
    }
    try {
      this.options.controlPlane.completeNodeAttempt({
        id: input.attemptId,
        workerId: input.workerId,
        status: input.status,
        ...(input.outputArtifactId ? { outputArtifactId: input.outputArtifactId } : {}),
        ...(input.error ? { error: input.error } : {}),
        ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
      });
      return true;
    } catch (error) {
      if (!this.#ownedUnexpiredAttempt(input.runId, input.attemptId, input.workerId)) {
        this.#recoverWorkspaceAttempts();
        return false;
      }
      throw error;
    }
  }

  #recoverWorkspaceAttempts(): void {
    this.options.controlPlane.recoverExpiredNodeAttempts(undefined, this.options.workspace);
  }
}
