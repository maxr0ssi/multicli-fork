import { useMemo, useState } from 'preact/hooks';

import type { StudioWorkflowSummary } from '../../types.js';
import { useModalDialog } from '../../useModalDialog.js';

interface WorkflowLauncherProps {
  readonly workflows: readonly StudioWorkflowSummary[];
  readonly busy: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onStart: (revisionId: string, objective: string) => Promise<void>;
}

export function WorkflowLauncher({
  workflows,
  busy,
  error,
  onClose,
  onStart,
}: WorkflowLauncherProps) {
  const [revisionId, setRevisionId] = useState(workflows[0]?.recordId ?? '');
  const [objective, setObjective] = useState('');
  const dialog = useModalDialog();
  const selected = useMemo(
    () => workflows.find(workflow => workflow.recordId === revisionId),
    [revisionId, workflows],
  );

  return (
    <dialog ref={dialog} class="workflow-dialog" aria-labelledby="launcher-title" onClose={onClose}>
      <form
        onSubmit={event => {
          event.preventDefault();
          if (revisionId && objective.trim()) void onStart(revisionId, objective.trim());
        }}
      >
        <div class="dialog-heading">
          <div><p class="context-label">New run</p><h2 id="launcher-title">Start a workflow</h2></div>
          <button class="button" type="button" disabled={busy} onClick={() => dialog.current?.close()}>Close</button>
        </div>
        <label class="form-field">
          <span>Workflow revision</span>
          <select value={revisionId} onChange={event => setRevisionId(event.currentTarget.value)}>
            {workflows.map(workflow => (
              <option value={workflow.recordId} key={workflow.recordId}>
                {workflow.name} · revision {workflow.logicalRevision}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <section class="launcher-review" aria-labelledby="launcher-review-title">
            <h3 id="launcher-review-title">What will run</h3>
            {selected.description && <p>{selected.description}</p>}
            <dl class="fact-list">
              <div><dt>Topology</dt><dd>{selected.nodeCount} nodes · {selected.agentCount} agents</dd></div>
              {selected.providers.length > 0 && <div><dt>Providers</dt><dd>{selected.providers.join(', ')}</dd></div>}
              {selected.models.length > 0 && <div><dt>Models</dt><dd>{selected.models.join(', ')}</dd></div>}
              <div><dt>Workspace access</dt><dd>{selected.workspaceAccess.join(', ') || 'No agent workspace access'}</dd></div>
              <div><dt>Write-capable agents</dt><dd>{selected.writerAgentCount}</dd></div>
              <div><dt>Nested agents</dt><dd>{selected.enableSubagents ? 'Enabled' : 'Disabled'}</dd></div>
            </dl>
          </section>
        )}
        <label class="form-field">
          <span>Objective and acceptance criteria</span>
          <textarea
            required
            maxLength={8000}
            value={objective}
            onInput={event => setObjective(event.currentTarget.value)}
            autofocus
          />
        </label>
        {error && <p class="action-error" role="alert">{error}</p>}
        <div class="dialog-actions">
          <button class="button" type="button" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
          <button class="button button-primary" type="submit" disabled={busy || !revisionId || !objective.trim()}>
            {busy ? 'Starting…' : 'Start workflow'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
