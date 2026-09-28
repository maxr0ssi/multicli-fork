const PREFIX = 'multicli:workflow-draft-launch';
const memoryKeys = new Map<string, string>();

/** Keeps an in-flight launch key stable across network retries and page reloads in this tab. */
export function stableDraftRunKey(
  draftId: string,
  version: number,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.sessionStorage,
  create: () => string = () => window.crypto.randomUUID(),
): string {
  const key = `${PREFIX}:${draftId}:${version}`;
  let generated: string | undefined;
  try {
    const existing = storage.getItem(key);
    if (existing) {
      memoryKeys.set(key, existing);
      return existing;
    }
    generated = create();
    storage.setItem(key, generated);
    memoryKeys.set(key, generated);
    return generated;
  } catch {
    const existing = memoryKeys.get(key);
    if (existing) return existing;
    const runId = generated ?? create();
    memoryKeys.set(key, runId);
    return runId;
  }
}
