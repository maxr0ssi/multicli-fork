import type { RunRecord } from './domain.js';

/** A failed agent node is terminal once its retry policy has been exhausted. */
export function terminalNodeFailureReason(run: RunRecord): string | undefined {
  for (const [nodeId, node] of Object.entries(run.nodeStates)) {
    if (node.status !== 'failed') continue;
    const attempt = [...node.attempts].reverse()
      .find(candidate => candidate.status === 'failed');
    if (attempt) return `Node ${nodeId} failed: ${attempt.error ?? 'Provider execution failed'}`;
  }
  return undefined;
}
