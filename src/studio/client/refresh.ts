import type { StudioBootstrap, StudioRunView } from './types.js';

export interface StudioReadApi {
  overview(): Promise<StudioBootstrap>;
  run(runId: string): Promise<StudioRunView>;
}

export interface StudioRefresh {
  readonly overview: StudioBootstrap;
  readonly view?: StudioRunView;
}

export async function refreshStudio(
  api: StudioReadApi,
  selectedRunId?: string,
): Promise<StudioRefresh> {
  const [overview, view] = await Promise.all([
    api.overview(),
    selectedRunId ? api.run(selectedRunId) : Promise.resolve(undefined),
  ]);
  return { overview, view };
}

export function mergeSelectedRunView(
  current: StudioRunView | undefined,
  incoming: StudioRunView,
  selectedRunId: string,
): StudioRunView | undefined {
  if (incoming.run.id !== selectedRunId) return current;
  if (!current || current.run.id !== selectedRunId) return incoming;
  const currentTime = Date.parse(current.serverTime);
  const incomingTime = Date.parse(incoming.serverTime);
  if (Number.isFinite(currentTime) && Number.isFinite(incomingTime) && incomingTime < currentTime) {
    return current;
  }
  return incoming;
}
