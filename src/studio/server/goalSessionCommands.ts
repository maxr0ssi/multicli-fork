import type { LocalControlPlane } from '../../controlPlane/controlPlane.js';
import type { Logger } from '../../logger.js';
import type { DurableRunRecord, GoalSessionRecord } from '../../persistence/runLedger.js';
import type { ResolvedProfile, WorkflowRevision } from '../../workflows/domain.js';
import { validateWorkflowRevision } from '../../workflows/graph.js';
import type { GoalSessionService } from '../../workflows/goalSession.js';
import { canonicalWorkspace } from '../../utils/canonicalWorkspace.js';

export interface OpenStudioGoalSessionInput {
  runId: string;
  profileId: string;
  goal: string;
}

export interface StudioGoalSessionCommandResult {
  id: string;
  runId?: string;
  profileId: string;
  provider: string;
  model: string;
  status: GoalSessionRecord['status'];
  turnState: GoalSessionRecord['turnState'];
  turnCount: number;
}

interface ActiveTurn {
  abort: AbortController;
  completion: Promise<void>;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function publicSession(session: GoalSessionRecord): StudioGoalSessionCommandResult {
  return {
    id: session.id,
    ...(session.runId ? { runId: session.runId } : {}),
    profileId: session.profileId,
    provider: session.provider,
    model: session.model,
    status: session.status,
    turnState: session.turnState,
    turnCount: session.turnCount,
  };
}

/**
 * Owns process-local handles for durable goal-session commands. Instruction
 * bodies are accepted only when they can start immediately; there is no
 * memory-only queue that could disappear on restart.
 */
export class StudioGoalSessionCommands {
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #workspace: string;

  constructor(private readonly options: {
    controlPlane: LocalControlPlane;
    sessions: GoalSessionService;
    workspace: string;
    logger: Logger;
  }) {
    this.#workspace = canonicalWorkspace(options.workspace);
  }

  open(input: OpenStudioGoalSessionInput): StudioGoalSessionCommandResult {
    const runId = requireText(input.runId, 'runId');
    const profileId = requireText(input.profileId, 'profileId');
    const goal = requireText(input.goal, 'goal');
    const run = this.options.controlPlane.ledger.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    this.#assertRunWorkspace(run);
    const workflow = this.options.controlPlane.ledger.getWorkflowRevision(
      run.workflowRevisionId,
    );
    if (!workflow) {
      throw new Error(`Unknown workflow revision: ${run.workflowRevisionId}`);
    }
    const definition = workflow.definition as WorkflowRevision;
    const validation = validateWorkflowRevision(definition);
    if (!validation.valid) throw new Error('The run workflow revision is invalid');
    const profile = definition.profiles.find(candidate => candidate.id === profileId);
    if (!profile) throw new Error(`Unknown workflow profile: ${profileId}`);
    const pinnedProfile: ResolvedProfile = {
      profileId: profile.id,
      provider: profile.provider,
      model: profile.model,
      ...(profile.reasoningEffort
        ? { reasoningEffort: profile.reasoningEffort }
        : {}),
      workspaceAccess: profile.workspaceAccess,
      selection: profile.selection,
      enableSubagents: profile.enableSubagents ?? false,
    };
    const session = this.options.sessions.openGoalSession({
      goal,
      profile: pinnedProfile,
      cwd: this.#workspace,
      runId,
      workflowRevisionId: workflow.id,
    }).inspect().session;
    return publicSession(session);
  }

  instruct(id: string, instruction: unknown): { accepted: true; sessionId: string } {
    const sessionId = requireText(id, 'sessionId');
    const text = requireText(instruction, 'instruction');
    const session = this.options.sessions.get(sessionId)?.inspect().session;
    if (!session) throw new Error(`Unknown goal session: ${sessionId}`);
    this.#assertSessionWorkspace(session);
    if (session.status !== 'active') {
      throw new Error(`Goal session ${sessionId} is ${session.status}`);
    }
    if (session.turnState === 'running' || this.#activeTurns.has(sessionId)) {
      throw new Error(`Goal session ${sessionId} already has a turn in flight`);
    }

    const abort = new AbortController();
    const completion = this.options.sessions.turn(sessionId, text, {
      signal: abort.signal,
    }).then(() => undefined).catch(error => {
      this.options.logger.error('studio_goal_turn_failed', {
        sessionId,
        runId: session.runId,
        error,
      });
    }).finally(() => {
      this.#activeTurns.delete(sessionId);
    });
    this.#activeTurns.set(sessionId, { abort, completion });
    return { accepted: true, sessionId };
  }

  async close(id: string): Promise<StudioGoalSessionCommandResult> {
    const sessionId = requireText(id, 'sessionId');
    const session = this.options.sessions.get(sessionId)?.inspect().session;
    if (!session) throw new Error(`Unknown goal session: ${sessionId}`);
    this.#assertSessionWorkspace(session);
    if (this.#activeTurns.has(sessionId)) {
      throw new Error(`Goal session ${sessionId} already has a turn in flight`);
    }
    return publicSession(await this.options.sessions.close(sessionId));
  }

  async shutdown(reason = 'Studio server shutting down'): Promise<void> {
    const active = [...this.#activeTurns.values()];
    for (const turn of active) turn.abort.abort(new Error(reason));
    await Promise.allSettled(active.map(turn => turn.completion));
  }

  #assertRunWorkspace(run: DurableRunRecord): void {
    if (!run.workspace) {
      throw new Error(`Run ${run.id} has no pinned workspace and is observer-only`);
    }
    if (run.workspace !== this.#workspace) {
      throw new Error(
        `Run ${run.id} belongs to ${run.workspace}; this Studio server is pinned to ${this.#workspace}`,
      );
    }
  }

  #assertSessionWorkspace(session: GoalSessionRecord): void {
    const workspace = canonicalWorkspace(session.cwd);
    if (workspace !== this.#workspace) {
      throw new Error(
        `Goal session ${session.id} belongs to ${workspace}; this Studio server is pinned to ${this.#workspace}`,
      );
    }
    if (!session.runId) return;
    const run = this.options.controlPlane.ledger.getRun(session.runId);
    if (!run) throw new Error(`Unknown run: ${session.runId}`);
    this.#assertRunWorkspace(run);
  }
}
