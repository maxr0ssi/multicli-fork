import type { LocalControlPlane } from '../controlPlane/controlPlane.js';

/**
 * A replacement runner may be elected before the dead worker's node lease
 * expires. Keep the run owned and re-check the durable lease instead of leaving
 * it permanently "running" with no process responsible for reconciliation.
 */
export async function waitForAttemptRecovery(input: {
  controlPlane: LocalControlPlane;
  runId: string;
  workspace: string;
  signal: AbortSignal;
}): Promise<boolean> {
  const running = input.controlPlane.ledger.listNodeAttempts(input.runId)
    .filter(attempt => attempt.status === 'running' && attempt.leaseExpiresAt);
  if (!running.length) return false;
  const nextExpiry = Math.min(...running.map(attempt => Date.parse(attempt.leaseExpiresAt!)));
  const delayMs = Number.isFinite(nextExpiry)
    ? Math.max(25, Math.min(1_000, nextExpiry - Date.now() + 1))
    : 25;
  await new Promise<void>(resolve => {
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      input.signal.removeEventListener('abort', stop);
      resolve();
    }, delayMs);
    input.signal.addEventListener('abort', stop, { once: true });
  });
  if (input.signal.aborted) return false;
  input.controlPlane.recoverExpiredNodeAttempts(undefined, input.workspace);
  return true;
}
