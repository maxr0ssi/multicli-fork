import type { LocalControlPlane } from '../controlPlane/controlPlane.js';
import type { RunRecord } from './domain.js';
import {
  hasRunningProviderAttempt,
  postTurnBudgetExhaustion,
} from './budgetAdmission.js';
import { terminalNodeFailureReason } from './runFailure.js';
import { waitForAttemptRecovery } from './runnerRecovery.js';

export type ProviderReconciliation = 'none' | 'continue' | 'stop';

/**
 * Finish calls that were already admitted before persisting a terminal budget
 * or failure event. No new provider work may pass this scheduling boundary.
 */
export async function reconcilePendingProviderTermination(input: {
  controlPlane: LocalControlPlane;
  runId: string;
  workspace: string;
  state: RunRecord;
  signal: AbortSignal;
  appendEvent: (
    type: string,
    payload: unknown,
    options: { idempotencyKey: string },
  ) => boolean;
}): Promise<ProviderReconciliation> {
  const budgetReason = postTurnBudgetExhaustion(input.state);
  const failureReason = terminalNodeFailureReason(input.state);
  if (!budgetReason && !failureReason) return 'none';
  if (hasRunningProviderAttempt(input.state)) {
    const recovered = await waitForAttemptRecovery({
      controlPlane: input.controlPlane,
      runId: input.runId,
      workspace: input.workspace,
      signal: input.signal,
    });
    return recovered ? 'continue' : 'stop';
  }
  input.appendEvent(
    budgetReason ? 'run.budget_exhausted' : 'run.failed',
    { reason: budgetReason ?? failureReason },
    {
      idempotencyKey: budgetReason
        ? 'run:budget-exhausted:admission'
        : 'run:failed:attempt-reconciliation',
    },
  );
  return 'stop';
}
