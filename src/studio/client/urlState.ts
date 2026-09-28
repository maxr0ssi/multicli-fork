export interface StudioSelection {
  runId?: string;
  nodeId?: string;
  draftId?: string;
}

export interface HistoryWriter {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

function selected(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function readStudioSelection(location: Pick<Location, 'href'>): StudioSelection {
  const url = new URL(location.href);
  const draftId = selected(url.searchParams.get('draft'));
  if (draftId) return { draftId };
  return {
    runId: selected(url.searchParams.get('run')),
    nodeId: selected(url.searchParams.get('node')),
    draftId: undefined,
  };
}

export function writeStudioSelection(
  history: HistoryWriter,
  location: Pick<Location, 'href'>,
  selection: StudioSelection,
): void {
  const url = new URL(location.href);
  if (selection.draftId) {
    url.searchParams.set('draft', selection.draftId);
    url.searchParams.delete('run');
    url.searchParams.delete('node');
  } else url.searchParams.delete('draft');
  if (!selection.draftId && selection.runId) url.searchParams.set('run', selection.runId);
  else url.searchParams.delete('run');
  if (!selection.draftId && selection.runId && selection.nodeId) url.searchParams.set('node', selection.nodeId);
  else url.searchParams.delete('node');
  history.replaceState(null, '', url);
}
