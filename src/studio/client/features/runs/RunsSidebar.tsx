import { useMemo, useState } from 'preact/hooks';

import { formatTime, readableState } from '../../format.js';
import type { StudioRunSummary } from '../../types.js';

interface RunsSidebarProps {
  readonly runs: readonly StudioRunSummary[];
  readonly selectedRunId?: string;
  readonly canLaunch: boolean;
  readonly onSelect: (runId: string) => void;
  readonly onLaunch: () => void;
}

export function RunsSidebar({
  runs,
  selectedRunId,
  canLaunch,
  onSelect,
  onLaunch,
}: RunsSidebarProps) {
  const [query, setQuery] = useState('');
  const visibleRuns = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return runs;
    return runs.filter(run => (
      run.workflowName.toLowerCase().includes(normalized)
      || run.objective?.toLowerCase().includes(normalized)
    ));
  }, [query, runs]);

  return (
    <nav class="runs-sidebar" aria-label="Workflow runs">
      <div class="sidebar-heading">
        <h2>Runs</h2>
        {canLaunch && <button class="button button-primary" type="button" onClick={onLaunch}>New workflow</button>}
      </div>
      {runs.length > 5 && (
        <label class="search-field">
          <span>Find a run</span>
          <input
            type="search"
            value={query}
            onInput={event => setQuery(event.currentTarget.value)}
          />
        </label>
      )}
      <div class="run-list">
        {visibleRuns.map(run => (
          <button
            type="button"
            class="run-list-item"
            data-state={run.status}
            aria-current={run.id === selectedRunId ? 'page' : undefined}
            onClick={() => onSelect(run.id)}
            key={run.id}
          >
            <span class="run-list-title">{run.workflowName}</span>
            {run.objective && <span class="run-list-objective">{run.objective}</span>}
            <span class="run-list-meta">
              <span class="status-text" data-state={run.status}>{readableState(run.status)}</span>
              <time dateTime={run.updatedAt}>{formatTime(run.updatedAt)}</time>
            </span>
          </button>
        ))}
        {visibleRuns.length === 0 && <p class="empty-state">No runs match your search.</p>}
      </div>
    </nav>
  );
}
