import type { WorkflowRevision } from '../../../../workflows/domain.js';

interface WorkflowDetailsWorkbenchProps {
  readonly definition: WorkflowRevision;
  readonly onChange: (definition: WorkflowRevision) => void;
  readonly onClose: () => void;
}

export function WorkflowDetailsWorkbench({
  definition,
  onChange,
  onClose,
}: WorkflowDetailsWorkbenchProps) {
  return (
    <aside class="draft-workbench" aria-labelledby="draft-details-title">
      <header class="draft-workbench-heading">
        <div><p class="context-label">Workflow draft</p><h3 id="draft-details-title">Details</h3></div>
        <button class="button" type="button" onClick={onClose}>Back to map</button>
      </header>
      <div class="draft-workbench-panel draft-workflow-fields">
        <label class="form-field">
          <span>Name</span>
          <input
            value={definition.name}
            onInput={event => onChange({ ...definition, name: event.currentTarget.value })}
          />
        </label>
        <label class="form-field draft-prompt-field">
          <span>Description</span>
          <textarea
            value={definition.description ?? ''}
            onInput={event => {
              const value = event.currentTarget.value;
              if (value) onChange({ ...definition, description: value });
              else {
                const { description: _removed, ...rest } = definition;
                onChange(rest);
              }
            }}
          />
        </label>
        <dl class="fact-list">
          <div><dt>Workflow id</dt><dd>{definition.id}</dd></div>
        </dl>
      </div>
    </aside>
  );
}
