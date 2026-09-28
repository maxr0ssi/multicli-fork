import type { StudioBootstrap, StudioRunView } from './types.js';
import type { StudioSelection } from './urlState.js';

export interface StudioRunTarget {
  readonly runId: string;
  readonly nodeId?: string;
}

export interface LoadedRunTarget {
  readonly view: StudioRunView;
  readonly nodeId?: string;
  readonly nodeIssue?: string;
}

interface RunReader {
  run(runId: string): Promise<StudioRunView>;
}

export function initialRunTarget(
  overview: StudioBootstrap,
  selection: StudioSelection,
): StudioRunTarget | undefined {
  if (selection.runId) return { runId: selection.runId, nodeId: selection.nodeId };
  const newestRunId = overview.runs[0]?.id;
  return newestRunId ? { runId: newestRunId } : undefined;
}

export async function loadRunTarget(
  api: RunReader,
  target: StudioRunTarget,
): Promise<LoadedRunTarget> {
  const view = await api.run(target.runId);
  if (view.run.id !== target.runId) {
    throw new Error(`Server returned run "${view.run.id}" instead.`);
  }
  if (!target.nodeId) return { view };
  if (view.workflow.nodes.some(node => node.id === target.nodeId)) {
    return { view, nodeId: target.nodeId };
  }
  return {
    view,
    nodeIssue: `Node "${target.nodeId}" is not part of run "${target.runId}". The run is open without a node inspector.`,
  };
}

export function runTargetError(runId: string, reason: unknown): string {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return `Could not open requested run "${runId}". ${detail}`;
}
