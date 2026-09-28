import {
  emptyBudgetUsage,
  resolveProfile,
  type AgentNode,
  type AttemptUsage,
  type BudgetUsage,
  type CreateInitialRunOptions,
  type GateResolvedEvent,
  type NodeAttempt,
  type NodeFailedEvent,
  type NodeRunState,
  type NodeStartedEvent,
  type NodeSucceededEvent,
  type RunEvent,
  type RunRecord,
  type WorkflowBudget,
  type WorkflowNode,
  type WorkflowRevision,
} from './domain.js';
import { buildWorkflowTopology, validateWorkflowRevision } from './graph.js';
import { postTurnBudgetExhaustion } from './budgetAdmission.js';
import { terminalNodeFailureReason } from './runFailure.js';
import {
  advanceControlFlow,
  cancelRun,
  exhaustRun,
  failRun,
  isRunTerminal,
  settleTerminalNodeFailure,
} from './runTransitions.js';

/** Raised when an event is not valid for the run's current deterministic state. */
export class WorkflowTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowTransitionError';
  }
}

function assertValidTimestamp(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
    throw new WorkflowTransitionError(`${label} must be an ISO-parseable timestamp.`);
  }
}

function appendEvent(run: RunRecord, event: RunEvent): RunRecord {
  return { ...run, events: [...run.events, event] };
}

function setNodeState(run: RunRecord, nodeId: string, state: NodeRunState): RunRecord {
  return {
    ...run,
    nodeStates: {
      ...run.nodeStates,
      [nodeId]: state,
    },
  };
}

function getNodeState(run: RunRecord, nodeId: string): NodeRunState {
  const state = run.nodeStates[nodeId];
  if (!state) {
    throw new WorkflowTransitionError(`Unknown node state: ${nodeId}.`);
  }
  return state;
}

function getNode(revision: WorkflowRevision, nodeId: string): WorkflowNode {
  const node = buildWorkflowTopology(revision).nodesById.get(nodeId);
  if (!node) {
    throw new WorkflowTransitionError(`Unknown workflow node: ${nodeId}.`);
  }
  return node;
}

function assertUsageDelta(usage: AttemptUsage | undefined): void {
  if (!usage) return;
  for (const [key, value] of Object.entries(usage)) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new WorkflowTransitionError(`Attempt usage ${key} must be a non-negative finite number.`);
    }
  }
}

function addUsage(base: BudgetUsage, delta: AttemptUsage | undefined): BudgetUsage {
  const reported = delta !== undefined
    && Object.values(delta).some(value => value !== undefined);
  return {
    modelCalls: base.modelCalls,
    nodeAttempts: base.nodeAttempts,
    usageReports: base.usageReports + (reported ? 1 : 0),
    estimatedCostUsd: base.estimatedCostUsd + (delta?.estimatedCostUsd ?? 0),
    inputTokens: base.inputTokens + (delta?.inputTokens ?? 0),
    cachedInputTokens: base.cachedInputTokens + (delta?.cachedInputTokens ?? 0),
    cacheCreationInputTokens:
      base.cacheCreationInputTokens + (delta?.cacheCreationInputTokens ?? 0),
    outputTokens: base.outputTokens + (delta?.outputTokens ?? 0),
    reasoningOutputTokens:
      base.reasoningOutputTokens + (delta?.reasoningOutputTokens ?? 0),
  };
}

function reserveAttempt(base: BudgetUsage): BudgetUsage {
  return {
    ...base,
    modelCalls: base.modelCalls + 1,
    nodeAttempts: base.nodeAttempts + 1,
  };
}

function attemptBudgetViolation(limits: WorkflowBudget, usage: BudgetUsage): string | undefined {
  if (limits.maxModelCalls !== undefined && usage.modelCalls > limits.maxModelCalls) {
    return `Model-call budget exhausted (${usage.modelCalls}/${limits.maxModelCalls}).`;
  }
  if (limits.maxNodeAttempts !== undefined && usage.nodeAttempts > limits.maxNodeAttempts) {
    return `Node-attempt budget exhausted (${usage.nodeAttempts}/${limits.maxNodeAttempts}).`;
  }
  return undefined;
}

function withUsage(run: RunRecord, usage: BudgetUsage): RunRecord {
  return {
    ...run,
    budget: {
      ...run.budget,
      usage,
    },
  };
}

function activeAttempt(state: NodeRunState, attemptId: string): NodeAttempt {
  if (state.status !== 'running' || state.activeAttemptId !== attemptId) {
    throw new WorkflowTransitionError(`Attempt ${attemptId} is not active for node ${state.nodeId}.`);
  }
  const attempt = state.attempts.find((candidate) => candidate.id === attemptId);
  if (!attempt || attempt.status !== 'running') {
    throw new WorkflowTransitionError(`Attempt ${attemptId} is not running for node ${state.nodeId}.`);
  }
  return attempt;
}

function completeAttempt(
  state: NodeRunState,
  attemptId: string,
  status: Extract<NodeAttempt['status'], 'succeeded' | 'failed'>,
  event: NodeSucceededEvent | NodeFailedEvent,
): NodeRunState {
  activeAttempt(state, attemptId);
  return {
    ...state,
    attempts: state.attempts.map((attempt) => (
      attempt.id === attemptId
        ? {
          ...attempt,
          status,
          finishedAt: event.at,
          usage: event.usage ?? {},
          ...(event.type === 'node.succeeded' && event.summary ? { summary: event.summary } : {}),
          ...(event.type === 'node.failed' ? { error: event.error } : {}),
        }
        : attempt
    )),
    activeAttemptId: undefined,
  };
}

function assertRunMatchesRevision(run: RunRecord, revision: WorkflowRevision): void {
  if (run.workflow.id !== revision.id || run.workflow.revision !== revision.revision) {
    throw new WorkflowTransitionError(
      `Run ${run.id} belongs to ${run.workflow.id}@${run.workflow.revision}, not ${revision.id}@${revision.revision}.`,
    );
  }
}

function assertEventBasics(event: RunEvent): void {
  if (typeof event.id !== 'string' || event.id.trim().length === 0) {
    throw new WorkflowTransitionError('Run event id must be a non-empty string.');
  }
  assertValidTimestamp(event.at, 'Run event timestamp');
}

/** Create a deterministic queued run; callers supply identity and time. */
export function createInitialRun(
  revision: WorkflowRevision,
  options: CreateInitialRunOptions,
): RunRecord {
  const validation = validateWorkflowRevision(revision);
  if (!validation.valid) {
    throw new WorkflowTransitionError(
      `Cannot create a run for an invalid workflow: ${validation.issues.map((issue) => issue.message).join(' ')}`,
    );
  }
  if (typeof options.id !== 'string' || options.id.trim().length === 0) {
    throw new WorkflowTransitionError('Run id must be a non-empty string.');
  }
  assertValidTimestamp(options.createdAt, 'Run creation timestamp');

  const nodeStates: Record<string, NodeRunState> = {};
  for (const node of revision.nodes) {
    nodeStates[node.id] = {
      nodeId: node.id,
      status: 'pending',
      attempts: [],
    };
  }

  return {
    id: options.id,
    workflow: { id: revision.id, revision: revision.revision },
    status: 'queued',
    nodeStates,
    budget: {
      limits: { ...(revision.budget ?? {}) },
      usage: emptyBudgetUsage(),
    },
    events: [],
    createdAt: options.createdAt,
  };
}

function reduceNodeStarted(
  run: RunRecord,
  revision: WorkflowRevision,
  event: NodeStartedEvent,
): RunRecord {
  const node = getNode(revision, event.nodeId);
  const state = getNodeState(run, event.nodeId);
  if (node.kind !== 'agent') {
    throw new WorkflowTransitionError(`Only agent nodes can start attempts; ${event.nodeId} is ${node.kind}.`);
  }
  if (state.status !== 'ready') {
    throw new WorkflowTransitionError(`Node ${event.nodeId} must be ready before it starts (currently ${state.status}).`);
  }
  if (state.attempts.some((attempt) => attempt.id === event.attemptId)) {
    throw new WorkflowTransitionError(`Attempt id ${event.attemptId} has already been used for node ${event.nodeId}.`);
  }

  const projectedUsage = reserveAttempt(run.budget.usage);
  const violation = attemptBudgetViolation(run.budget.limits, projectedUsage);
  if (violation) {
    return exhaustRun(run, event.at, violation);
  }

  const profile = buildWorkflowTopology(revision).profilesById.get((node as AgentNode).profileId);
  if (!profile) {
    throw new WorkflowTransitionError(`Profile ${(node as AgentNode).profileId} disappeared from workflow revision.`);
  }
  const attempt: NodeAttempt = {
    id: event.attemptId,
    number: state.attempts.length + 1,
    status: 'running',
    profile: resolveProfile(profile),
    startedAt: event.at,
    usage: {},
  };

  return withUsage(
    setNodeState(run, event.nodeId, {
      ...state,
      status: 'running',
      attempts: [...state.attempts, attempt],
      activeAttemptId: event.attemptId,
    }),
    projectedUsage,
  );
}

function reduceNodeSucceeded(
  run: RunRecord,
  revision: WorkflowRevision,
  event: NodeSucceededEvent,
): RunRecord {
  assertUsageDelta(event.usage);
  const node = getNode(revision, event.nodeId);
  if (node.kind !== 'agent') {
    throw new WorkflowTransitionError(`Only agent nodes can complete attempts; ${event.nodeId} is ${node.kind}.`);
  }
  const state = completeAttempt(getNodeState(run, event.nodeId), event.attemptId, 'succeeded', event);
  let next = setNodeState(run, event.nodeId, { ...state, status: 'succeeded' });
  next = withUsage(next, addUsage(next.budget.usage, event.usage));
  // Do not terminalize siblings whose provider calls were already admitted.
  // The runner persists one budget-exhausted event after those calls reconcile.
  if (postTurnBudgetExhaustion(next)) return next;
  if (terminalNodeFailureReason(next)) return settleTerminalNodeFailure(next, event.at);
  return advanceControlFlow(next, revision, event.at);
}

function reduceNodeFailed(
  run: RunRecord,
  revision: WorkflowRevision,
  event: NodeFailedEvent,
): RunRecord {
  assertUsageDelta(event.usage);
  const node = getNode(revision, event.nodeId);
  if (node.kind !== 'agent') {
    throw new WorkflowTransitionError(`Only agent nodes can fail attempts; ${event.nodeId} is ${node.kind}.`);
  }
  const state = completeAttempt(getNodeState(run, event.nodeId), event.attemptId, 'failed', event);
  let next = setNodeState(run, event.nodeId, state);
  next = withUsage(next, addUsage(next.budget.usage, event.usage));
  if (postTurnBudgetExhaustion(next)) {
    return setNodeState(next, event.nodeId, { ...state, status: 'failed' });
  }

  const maxAttempts = node.maxAttempts ?? 1;
  const mayRetry = event.retryable !== false && state.attempts.length < maxAttempts;
  next = setNodeState(next, event.nodeId, {
    ...state,
    status: mayRetry ? 'ready' : 'failed',
  });
  return terminalNodeFailureReason(next)
    ? settleTerminalNodeFailure(next, event.at)
    : next;
}

function reduceGateResolved(
  run: RunRecord,
  revision: WorkflowRevision,
  event: GateResolvedEvent,
): RunRecord {
  const node = getNode(revision, event.nodeId);
  const state = getNodeState(run, event.nodeId);
  if (node.kind !== 'gate') {
    throw new WorkflowTransitionError(`Only gate nodes accept gate decisions; ${event.nodeId} is ${node.kind}.`);
  }
  if (state.status !== 'waiting_for_gate') {
    throw new WorkflowTransitionError(`Gate ${event.nodeId} is not awaiting a decision (currently ${state.status}).`);
  }
  if (event.decision === 'rejected') {
    return failRun(
      setNodeState(run, event.nodeId, { ...state, status: 'failed', gateDecision: 'rejected' }),
      event.at,
      event.note ? `Gate ${event.nodeId} rejected: ${event.note}` : `Gate ${event.nodeId} rejected.`,
    );
  }
  return advanceControlFlow(
    setNodeState(run, event.nodeId, { ...state, status: 'succeeded', gateDecision: 'approved' }),
    revision,
    event.at,
  );
}

/**
 * Apply one external event without mutation. Given the same revision, previous
 * run, and event, the result is deterministic. Duplicate event ids are
 * idempotent so a durable event store can safely retry delivery.
 */
export function reduceRunEvent(
  run: RunRecord,
  revision: WorkflowRevision,
  event: RunEvent,
): RunRecord {
  assertRunMatchesRevision(run, revision);
  assertEventBasics(event);
  if (run.events.some((existing) => existing.id === event.id)) {
    return run;
  }
  if (isRunTerminal(run.status)) {
    throw new WorkflowTransitionError(`Run ${run.id} is ${run.status}; it cannot accept ${event.type}.`);
  }

  let next = appendEvent(run, event);
  switch (event.type) {
    case 'run.started':
      if (next.status !== 'queued') {
        throw new WorkflowTransitionError(`Run ${next.id} must be queued before it starts.`);
      }
      next = { ...next, status: 'running', startedAt: event.at };
      return advanceControlFlow(next, revision, event.at);
    case 'node.started':
      if (next.status !== 'running') {
        throw new WorkflowTransitionError(`Run ${next.id} must be running before a node can start.`);
      }
      return reduceNodeStarted(next, revision, event);
    case 'node.succeeded':
      if (next.status !== 'running') {
        throw new WorkflowTransitionError(`Run ${next.id} must be running before a node can succeed.`);
      }
      return reduceNodeSucceeded(next, revision, event);
    case 'node.failed':
      if (next.status !== 'running') {
        throw new WorkflowTransitionError(`Run ${next.id} must be running before a node can fail.`);
      }
      return reduceNodeFailed(next, revision, event);
    case 'gate.resolved':
      if (next.status !== 'running') {
        throw new WorkflowTransitionError(`Run ${next.id} must be running before a gate can resolve.`);
      }
      return reduceGateResolved(next, revision, event);
    case 'run.cancelled':
      return cancelRun(next, event.at, event.reason ?? 'Run cancelled.');
    case 'run.budget_exhausted':
      return exhaustRun(next, event.at, event.reason);
  }
}
