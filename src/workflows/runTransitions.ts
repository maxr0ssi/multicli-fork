import type {
  NodeAttempt,
  NodeRunState,
  NodeStatus,
  RunRecord,
  RunStatus,
  WorkflowRevision,
} from './domain.js';
import { buildWorkflowTopology } from './graph.js';
import { hasRunningProviderAttempt } from './budgetAdmission.js';
import { terminalNodeFailureReason } from './runFailure.js';

export function isRunTerminal(status: RunStatus): boolean {
  return status === 'succeeded'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'budget_exhausted';
}

function isNodeTerminal(status: NodeStatus): boolean {
  return status === 'succeeded'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'budget_exhausted';
}

function stopAttempt(
  attempt: NodeAttempt,
  status: Extract<NodeAttempt['status'], 'failed' | 'cancelled' | 'budget_exhausted'>,
  at: string,
  reason: string,
): NodeAttempt {
  return attempt.status === 'running'
    ? { ...attempt, status, finishedAt: at, error: reason }
    : attempt;
}

function terminalizeOpenNodes(
  run: RunRecord,
  runStatus: Extract<RunStatus, 'failed' | 'cancelled' | 'budget_exhausted'>,
  at: string,
  reason: string,
): RunRecord {
  const nodeStatus = runStatus === 'budget_exhausted' ? 'budget_exhausted' : 'cancelled';
  const attemptStatus = runStatus === 'budget_exhausted' ? 'budget_exhausted' : 'cancelled';
  const nodeStates: Record<string, NodeRunState> = {};
  for (const [nodeId, state] of Object.entries(run.nodeStates)) {
    nodeStates[nodeId] = isNodeTerminal(state.status) ? state : {
      ...state,
      status: nodeStatus,
      attempts: state.attempts.map(attempt => (
        stopAttempt(attempt, attemptStatus, at, reason)
      )),
      activeAttemptId: undefined,
    };
  }
  return {
    ...run,
    status: runStatus,
    nodeStates,
    completedAt: at,
    failureReason: reason,
  };
}

export function failRun(run: RunRecord, at: string, reason: string): RunRecord {
  return terminalizeOpenNodes(run, 'failed', at, reason);
}

export function settleTerminalNodeFailure(run: RunRecord, at: string): RunRecord {
  const reason = terminalNodeFailureReason(run);
  return reason && !hasRunningProviderAttempt(run) ? failRun(run, at, reason) : run;
}

export function exhaustRun(run: RunRecord, at: string, reason: string): RunRecord {
  return terminalizeOpenNodes(run, 'budget_exhausted', at, reason);
}

export function cancelRun(run: RunRecord, at: string, reason: string): RunRecord {
  return terminalizeOpenNodes(run, 'cancelled', at, reason);
}

function setNodeState(run: RunRecord, nodeId: string, state: NodeRunState): RunRecord {
  return { ...run, nodeStates: { ...run.nodeStates, [nodeId]: state } };
}

/** Advance only deterministic control nodes; provider calls are scheduled elsewhere. */
export function advanceControlFlow(
  run: RunRecord,
  revision: WorkflowRevision,
  at: string,
): RunRecord {
  const topology = buildWorkflowTopology(revision);
  let current = run;
  let changed = true;
  while (changed && current.status === 'running') {
    changed = false;
    for (const node of revision.nodes) {
      const state = current.nodeStates[node.id];
      if (!state || state.status !== 'pending') continue;
      const parents = topology.incoming.get(node.id) ?? [];
      if (!parents.every(parent => current.nodeStates[parent]?.status === 'succeeded')) continue;
      const status = node.kind === 'agent'
        ? 'ready'
        : node.kind === 'gate'
          ? 'waiting_for_gate'
          : 'succeeded';
      current = setNodeState(current, node.id, { ...state, status });
      changed = true;
    }
  }
  const endSucceeded = topology.ends.length > 0
    && topology.ends.every(id => current.nodeStates[id]?.status === 'succeeded');
  return endSucceeded && current.status === 'running'
    ? { ...current, status: 'succeeded', completedAt: at }
    : current;
}
