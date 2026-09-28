export interface StudioCliLaunchTarget {
  draftId?: string;
  runId?: string;
  nodeId?: string;
  workspace?: string;
  storePath?: string;
}

export interface StudioCliLaunchHandoff {
  readonly command: 'multicli';
  readonly args: readonly string[];
  readonly displayCommand: string;
}

function displayArgument(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

/** One structured launch contract shared by chat drafts and run receipts. */
export function studioCliLaunchHandoff(
  target: StudioCliLaunchTarget,
): StudioCliLaunchHandoff {
  if (target.draftId && target.runId) {
    throw new Error('A Studio launch cannot target both a draft and a run');
  }
  if (target.nodeId && !target.runId) {
    throw new Error('A Studio node target requires a run target');
  }
  const args = [
    'studio',
    ...(target.draftId ? ['--draft', target.draftId] : []),
    ...(target.runId ? ['--run', target.runId] : []),
    ...(target.nodeId ? ['--node', target.nodeId] : []),
    ...(target.workspace ? ['--workspace', target.workspace] : []),
    ...(target.storePath ? ['--store', target.storePath] : []),
  ];
  return {
    command: 'multicli',
    args,
    displayCommand: ['multicli', ...args].map(displayArgument).join(' '),
  };
}
