function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

/** Exact, deterministic JSON context appended to every provider turn. */
export function renderWorkflowRunContext(input: unknown): string {
  return JSON.stringify(sortJson(input ?? null), null, 2) ?? 'null';
}
