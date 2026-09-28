import type { RunRecord } from './domain.js';

export interface ProviderCallAdmission {
  /** Number of provider calls that may be scheduled from the current snapshot. */
  capacity: number;
  /** Present when a call/attempt limit forbids every further provider call. */
  exhaustedReason?: string;
}

function remaining(limit: number | undefined, used: number): number {
  return limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, limit - used);
}

/**
 * Token and cost limits can only be evaluated after a provider reports usage.
 * Crossing one is a scheduling boundary, not permission to discard results
 * from provider attempts that were already admitted.
 */
export function postTurnBudgetExhaustion(run: RunRecord): string | undefined {
  const { limits, usage } = run.budget;
  if (limits.maxEstimatedCostUsd !== undefined
    && usage.estimatedCostUsd > limits.maxEstimatedCostUsd) {
    return `Estimated-cost budget exhausted (${usage.estimatedCostUsd}/${limits.maxEstimatedCostUsd} USD).`;
  }
  if (limits.maxInputTokens !== undefined && usage.inputTokens > limits.maxInputTokens) {
    return `Input-token budget exhausted (${usage.inputTokens}/${limits.maxInputTokens}).`;
  }
  if (limits.maxOutputTokens !== undefined && usage.outputTokens > limits.maxOutputTokens) {
    return `Output-token budget exhausted (${usage.outputTokens}/${limits.maxOutputTokens}).`;
  }
  return undefined;
}

/**
 * Admit provider work before it is scheduled. Token and cost limits remain
 * post-turn boundaries because their next value cannot be known in advance.
 */
export function providerCallAdmission(
  run: RunRecord,
  requested: number,
): ProviderCallAdmission {
  const requestedCount = Math.max(0, Math.trunc(requested));
  const { limits, usage } = run.budget;
  const reportedUsageBoundary = postTurnBudgetExhaustion(run);
  if (reportedUsageBoundary) {
    return { capacity: 0, exhaustedReason: reportedUsageBoundary };
  }
  const callsRemaining = remaining(limits.maxModelCalls, usage.modelCalls);
  const attemptsRemaining = remaining(limits.maxNodeAttempts, usage.nodeAttempts);
  const capacity = Math.min(requestedCount, callsRemaining, attemptsRemaining);

  if (capacity > 0 || requestedCount === 0) return { capacity };
  if (callsRemaining === 0 && limits.maxModelCalls !== undefined) {
    return {
      capacity: 0,
      exhaustedReason:
        `Model-call budget exhausted (${usage.modelCalls}/${limits.maxModelCalls}); `
        + 'no further provider calls may start.',
    };
  }
  if (attemptsRemaining === 0 && limits.maxNodeAttempts !== undefined) {
    return {
      capacity: 0,
      exhaustedReason:
        `Node-attempt budget exhausted (${usage.nodeAttempts}/${limits.maxNodeAttempts}); `
        + 'no further provider calls may start.',
    };
  }
  return { capacity: 0 };
}

export function hasRunningProviderAttempt(run: RunRecord): boolean {
  return Object.values(run.nodeStates).some(node => node.status === 'running');
}
