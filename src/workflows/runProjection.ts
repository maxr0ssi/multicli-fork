import type { DurableRunEvent } from '../persistence/runLedger.js';
import {
  createInitialRun,
  reduceRunEvent,
} from './reducer.js';
import type {
  RunEvent,
  RunRecord,
  WorkflowRevision,
} from './domain.js';
import { attemptUsageFromUnknown } from './goalSessionUsage.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Convert the durable event vocabulary into the pure workflow reducer vocabulary. */
export function durableEventToRunEvent(event: DurableRunEvent): RunEvent | undefined {
  const payload = record(event.payload) ?? {};
  const base = { id: `${event.runId}:${event.sequence}`, at: event.timestamp };
  switch (event.type) {
    case 'run.started':
      return { ...base, type: 'run.started' };
    case 'run.cancelled':
      return { ...base, type: 'run.cancelled', reason: text(payload.reason) };
    case 'run.budget_exhausted':
      return {
        ...base,
        type: 'run.budget_exhausted',
        reason: text(payload.reason) ?? 'Workflow budget exhausted.',
      };
    case 'node.started': {
      const nodeId = text(payload.nodeId);
      const attemptId = text(payload.attemptId);
      return nodeId && attemptId
        ? { ...base, type: 'node.started', nodeId, attemptId }
        : undefined;
    }
    case 'node.succeeded': {
      const nodeId = text(payload.nodeId);
      const attemptId = text(payload.attemptId);
      return nodeId && attemptId
        ? {
          ...base,
          type: 'node.succeeded',
          nodeId,
          attemptId,
          summary: text(payload.summary),
          usage: attemptUsageFromUnknown(payload.usage),
        }
        : undefined;
    }
    case 'node.failed': {
      const nodeId = text(payload.nodeId);
      const attemptId = text(payload.attemptId);
      return nodeId && attemptId
        ? {
          ...base,
          type: 'node.failed',
          nodeId,
          attemptId,
          error: text(payload.error) ?? 'Provider execution failed',
          retryable: typeof payload.retryable === 'boolean' ? payload.retryable : undefined,
          usage: attemptUsageFromUnknown(payload.usage),
        }
        : undefined;
    }
    case 'gate.resolved': {
      const nodeId = text(payload.nodeId);
      const decision = payload.decision;
      return nodeId && (decision === 'approved' || decision === 'rejected')
        ? { ...base, type: 'gate.resolved', nodeId, decision, note: text(payload.note) }
        : undefined;
    }
    default:
      return undefined;
  }
}

/** Deterministically project semantic node state from one immutable revision and its events. */
export function projectWorkflowRun(input: {
  revision: WorkflowRevision;
  runId: string;
  createdAt: string;
  events: readonly DurableRunEvent[];
}): RunRecord {
  let state = createInitialRun(input.revision, {
    id: input.runId,
    createdAt: input.createdAt,
  });
  for (const event of input.events) {
    const converted = durableEventToRunEvent(event);
    if (converted) state = reduceRunEvent(state, input.revision, converted);
  }
  return state;
}
