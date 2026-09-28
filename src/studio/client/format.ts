export function readableState(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
}

export function formatDuration(start?: string, end?: string): string | undefined {
  if (!start) return undefined;
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

export function formatBytes(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function eventMessage(type: string, payload: unknown): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const key of ['summary', 'message', 'error', 'reason']) {
      if (typeof record[key] === 'string' && record[key]) return String(record[key]);
    }
    if (typeof record.nodeId === 'string') return `${type} · ${record.nodeId}`;
  }
  return type;
}
