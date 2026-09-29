import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  GoalSessionArtifactRecord,
  GoalSessionRecord,
  RunLedger,
} from '../persistence/runLedger.js';
import { isValidNativeSessionId } from '../utils/conversationStore.js';
import type { AttemptUsage, ResolvedProfile, WorkflowProfile } from './domain.js';
import type {
  WorkflowProviderExecutor,
} from './executor.js';
import {
  attemptUsageFromUnknown,
  goalSessionTurnMetadata,
} from './goalSessionUsage.js';
import { ProviderExecutionError } from './providerUsage.js';
import { NativeSessionError, validateGoalNativeSession } from './goalSessionNative.js';
import {
  buildGoalSessionPrompt,
  nonEmpty,
  normalizedGoalProfile,
  writeGoalFile,
  writeGoalTurnArtifact,
  writeGoalTurnUsageArtifact,
} from './goalSessionArtifacts.js';

const DEFAULT_TURN_LEASE_MS = 60 * 60 * 1_000;

export interface OpenGoalSessionInput {
  id?: string;
  goal: string;
  profile: ResolvedProfile | WorkflowProfile;
  cwd: string;
  /** Optional live run whose metadata becomes visible to the permanent agent. */
  runId?: string;
  /** Optional immutable workflow link for a standalone planning session. */
  workflowRevisionId?: string;
}

export interface GoalSessionTurnResult {
  text: string;
  session: GoalSessionRecord;
  instructionArtifact: GoalSessionArtifactRecord;
  replyArtifact: GoalSessionArtifactRecord;
  /** Present only when the provider reported at least one usage field. */
  usage?: AttemptUsage;
}

export interface GoalSessionServiceOptions {
  store: RunLedger;
  executor: WorkflowProviderExecutor;
  artifactRoot: string;
  turnLeaseMs?: number;
  /** Projects newly persisted run events into a live control-plane stream. */
  onRunEvents?: (runId: string, afterSequence: number) => void;
}

export interface GoalSessionInspection {
  session: GoalSessionRecord;
  artifacts: GoalSessionArtifactRecord[];
}

/**
 * A durable handle for one pinned provider-native conversation.
 *
 * Callers cannot mutate the profile, workspace, or cwd through this handle;
 * every turn reloads those pins from SQLite before invoking the local CLI.
 */
export class PersistentGoalSession {
  constructor(
    readonly id: string,
    private readonly service: GoalSessionService,
  ) {}

  inspect(): GoalSessionInspection {
    return this.service.inspect(this.id);
  }

  turn(instruction: string, options: { signal?: AbortSignal } = {}): Promise<GoalSessionTurnResult> {
    return this.service.turn(this.id, instruction, options);
  }

  close(): Promise<GoalSessionRecord> {
    return this.service.close(this.id);
  }
}

/** Manages standalone or workflow-bound permanent local-CLI sessions. */
export class GoalSessionService {
  readonly #turnLeaseMs: number;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #shutdown = new AbortController();
  #closing?: Promise<void>;

  constructor(private readonly options: GoalSessionServiceOptions) {
    this.#turnLeaseMs = options.turnLeaseMs ?? DEFAULT_TURN_LEASE_MS;
    if (!Number.isFinite(this.#turnLeaseMs) || this.#turnLeaseMs <= 0) {
      throw new Error('Goal session turnLeaseMs must be positive');
    }
  }

  openGoalSession(input: OpenGoalSessionInput): PersistentGoalSession {
    this.#assertOpen();
    const goal = nonEmpty(input.goal, 'Goal');
    const profile = normalizedGoalProfile(input.profile);
    let runSequence: number | undefined;
    if (!path.isAbsolute(input.cwd)) {
      throw new Error('Goal session cwd must be an absolute path');
    }
    if (profile.provider !== 'codex' && profile.provider !== 'claude') {
      throw new Error(
        `Persistent goal sessions require a local provider CLI with native resume support; received ${profile.provider}`,
      );
    }
    if (input.runId) {
      const run = this.options.store.getRun(input.runId);
      if (!run) throw new Error(`Unknown run: ${input.runId}`);
      runSequence = run.lastSequence;
      if (input.workflowRevisionId && input.workflowRevisionId !== run.workflowRevisionId) {
        throw new Error(
          `Goal session workflow revision ${input.workflowRevisionId} does not match run ${input.runId}`,
        );
      }
    }
    if (input.workflowRevisionId && !this.options.store.getWorkflowRevision(input.workflowRevisionId)) {
      throw new Error(`Unknown workflow revision: ${input.workflowRevisionId}`);
    }

    const id = input.id ?? randomUUID();
    if (!isValidNativeSessionId(id)) {
      throw new Error('Goal session id must be a UUID');
    }
    if (this.options.store.getGoalSession(id)) {
      throw new Error(`Goal session ${id} already exists`);
    }
    const goalFile = writeGoalFile(this.options.artifactRoot, id, goal);
    try {
      const record = this.options.store.createGoalSession({
        id,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.workflowRevisionId ? { workflowRevisionId: input.workflowRevisionId } : {}),
        profileId: profile.profileId,
        provider: profile.provider,
        model: profile.model,
        ...(profile.reasoningEffort
          ? { reasoningEffort: profile.reasoningEffort }
          : {}),
        workspaceAccess: profile.workspaceAccess,
        selection: profile.selection,
        enableSubagents: profile.enableSubagents,
        cwd: path.resolve(input.cwd),
        goalArtifact: {
          contentHash: goalFile.contentHash,
          mediaType: 'text/markdown',
          name: 'Permanent goal',
          location: goalFile.location,
          metadata: { private: true },
        },
      });
      if (record.runId) this.#notifyRunEvents(record.runId, runSequence ?? 0);
    } catch (error) {
      try {
        fs.unlinkSync(goalFile.location);
      } catch {
        // Best effort only: the ledger remains authoritative even if cleanup is unavailable.
      }
      throw error;
    }
    return new PersistentGoalSession(id, this);
  }

  get(id: string): PersistentGoalSession | undefined {
    this.#assertOpen();
    return this.options.store.getGoalSession(id)
      ? new PersistentGoalSession(id, this)
      : undefined;
  }

  list(runId?: string, limit?: number): GoalSessionRecord[] {
    this.#assertOpen();
    return this.options.store.listGoalSessions(runId, limit);
  }

  inspect(id: string): GoalSessionInspection {
    this.#assertOpen();
    const session = this.options.store.getGoalSession(id);
    if (!session) throw new Error(`Unknown goal session: ${id}`);
    return {
      session,
      artifacts: this.options.store.listGoalSessionArtifacts(id),
    };
  }

  async turn(
    id: string,
    instruction: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<GoalSessionTurnResult> {
    this.#assertOpen();
    const normalized = nonEmpty(instruction, 'Goal session instruction');
    const signal = options.signal
      ? AbortSignal.any([this.#shutdown.signal, options.signal])
      : this.#shutdown.signal;
    return this.#serialize(id, () => {
      signal.throwIfAborted();
      return this.#executeTurn(id, normalized, signal);
    });
  }

  close(id: string): Promise<GoalSessionRecord> {
    return this.#serialize(id, async () => {
      const current = this.options.store.getGoalSession(id);
      const sequence = current?.runId
        ? this.options.store.getRun(current.runId)?.lastSequence ?? 0
        : 0;
      const closed = this.options.store.closeGoalSession(id);
      if (closed.runId) this.#notifyRunEvents(closed.runId, sequence);
      return closed;
    });
  }

  shutdown(reason = 'Goal session service shutting down'): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#shutdown.abort(new Error(reason));
    this.#closing = Promise.allSettled([...this.#tails.values()]).then(() => undefined);
    return this.#closing;
  }

  #assertOpen(): void {
    if (this.#shutdown.signal.aborted) throw new Error('GoalSessionService is closed.');
  }

  async #executeTurn(
    id: string,
    instruction: string,
    signal?: AbortSignal,
  ): Promise<GoalSessionTurnResult> {
    const owner = randomUUID();
    const beforeClaim = this.options.store.getGoalSession(id);
    const claimSequence = beforeClaim?.runId
      ? this.options.store.getRun(beforeClaim.runId)?.lastSequence ?? 0
      : 0;
    const claimed = this.options.store.claimGoalSessionTurn({
      id,
      owner,
      leaseMs: this.#turnLeaseMs,
    });
    if (!claimed) {
      throw new Error(`Goal session ${id} already has a turn in flight`);
    }
    if (claimed.runId) this.#notifyRunEvents(claimed.runId, claimSequence);
    const turnNumber = claimed.turnCount + 1;
    const resumed = Boolean(claimed.nativeSessionId);
    let instructionArtifact: GoalSessionArtifactRecord | undefined;
    let providerInvoked = false;
    let providerReturned = false;
    let telemetryPersisted = false;
    let returnedNativeSessionId: string | undefined;
    let reportedUsage: AttemptUsage | undefined;
    let blockReason: Parameters<RunLedger['blockGoalSessionTurn']>[0]['reason'] =
      'post_provider_persistence_failed';
    try {
      instructionArtifact = writeGoalTurnArtifact({
        store: this.options.store,
        artifactRoot: this.options.artifactRoot,
        session: claimed,
        turnNumber,
        kind: 'instruction',
        text: instruction,
      });
      const requestPrompt = buildGoalSessionPrompt({
        store: this.options.store,
        session: claimed,
        instruction,
      });
      providerInvoked = true;
      const result = await this.options.executor.execute({
        profile: {
          profileId: claimed.profileId,
          provider: claimed.provider,
          model: claimed.model,
          ...(claimed.reasoningEffort ? { reasoningEffort: claimed.reasoningEffort } : {}),
          workspaceAccess: claimed.workspaceAccess as ResolvedProfile['workspaceAccess'],
          selection: claimed.selection,
          enableSubagents: claimed.enableSubagents,
        },
        prompt: requestPrompt,
        cwd: claimed.cwd,
        ...(signal ? { signal } : {}),
        heartbeatMs: Math.max(1_000, Math.min(30_000, Math.floor(this.#turnLeaseMs / 3))),
        onHeartbeat: () => {
          this.options.store.renewGoalSessionTurnLease({
            id: claimed.id,
            owner,
            leaseMs: this.#turnLeaseMs,
          });
        },
        session: claimed.nativeSessionId
          ? { mode: 'resume', sessionId: claimed.nativeSessionId }
          : claimed.provider === 'claude'
            ? { mode: 'start', sessionId: randomUUID() }
            : { mode: 'start' },
      });
      providerReturned = true;
      returnedNativeSessionId = result.sessionId;
      reportedUsage = attemptUsageFromUnknown(result.usage);
      const nativeSessionId = validateGoalNativeSession(claimed, result);
      const replyArtifact = writeGoalTurnArtifact({
        store: this.options.store,
        artifactRoot: this.options.artifactRoot,
        session: claimed,
        turnNumber,
        kind: 'reply',
        text: result.text,
        metadata: goalSessionTurnMetadata({
          outcome: 'succeeded',
          resumed,
          ...(reportedUsage ? { usage: reportedUsage } : {}),
        }),
      });
      telemetryPersisted = true;
      const completionSequence = claimed.runId
        ? this.options.store.getRun(claimed.runId)?.lastSequence ?? 0
        : 0;
      const session = this.options.store.completeGoalSessionTurn({
        id,
        owner,
        nativeSessionId,
        instructionArtifactId: instructionArtifact.id,
        replyArtifactId: replyArtifact.id,
      });
      if (claimed.runId) this.#notifyRunEvents(claimed.runId, completionSequence);
      return {
        text: result.text,
        session,
        instructionArtifact,
        replyArtifact,
        ...(reportedUsage ? { usage: reportedUsage } : {}),
      };
    } catch (error) {
      if (error instanceof NativeSessionError) blockReason = error.reason;
      const providerFailure = error instanceof ProviderExecutionError ? error : undefined;
      returnedNativeSessionId ??= providerFailure?.details.sessionId;
      reportedUsage ??= attemptUsageFromUnknown(providerFailure?.details.usage);
      const current = this.options.store.getGoalSession(id);
      if (current?.turnState === 'running' && current.turnOwner === owner) {
        const failureSequence = current.runId
          ? this.options.store.getRun(current.runId)?.lastSequence ?? 0
          : 0;
        if (providerInvoked && instructionArtifact && !telemetryPersisted) {
          try {
            writeGoalTurnUsageArtifact({
              store: this.options.store,
              artifactRoot: this.options.artifactRoot,
              session: current,
              turnNumber,
              outcome: providerReturned ? 'blocked' : 'failed',
              resumed,
              ...(reportedUsage ? { usage: reportedUsage } : {}),
            });
          } catch {
            // Session cleanup must still run if telemetry cannot be committed.
          }
        }
        if (providerReturned) {
          const safeReturnedId = returnedNativeSessionId
            && isValidNativeSessionId(returnedNativeSessionId)
            && (!current.nativeSessionId || current.nativeSessionId === returnedNativeSessionId)
            ? returnedNativeSessionId
            : undefined;
          this.options.store.blockGoalSessionTurn({
            id,
            owner,
            ...(safeReturnedId ? { nativeSessionId: safeReturnedId } : {}),
            reason: blockReason,
          });
        } else {
          this.options.store.failGoalSessionTurn({
            id,
            owner,
            reason: 'provider_execution_failed',
          });
        }
        if (current.runId) this.#notifyRunEvents(current.runId, failureSequence);
      }
      throw error;
    }
  }

  #notifyRunEvents(runId: string, afterSequence: number): void {
    try {
      this.options.onRunEvents?.(runId, afterSequence);
    } catch {
      // The ledger is authoritative. A broken live listener must never turn a
      // committed provider result into an uncertain or replayable turn.
    }
  }

  async #serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const previous = this.#tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.#tails.set(id, tail);
    await previous;
    try {
      this.#assertOpen();
      return await operation();
    } finally {
      release();
      if (this.#tails.get(id) === tail) this.#tails.delete(id);
    }
  }
}
/** Convenience constructor for callers that do not need to retain the manager. */
export function openGoalSession(
  options: GoalSessionServiceOptions,
  input: OpenGoalSessionInput,
): PersistentGoalSession {
  return new GoalSessionService(options).openGoalSession(input);
}
