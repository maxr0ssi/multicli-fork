import { useEffect, useState } from 'preact/hooks';

import { visibleRunActions } from '../../actionVisibility.js';
import { ConfirmationDialog } from '../../components/ConfirmationDialog.js';
import { formatTime, readableState } from '../../format.js';
import type { StudioRunAction, StudioRunView } from '../../types.js';

interface RunHeaderProps {
  readonly view: StudioRunView;
  readonly busyAction?: StudioRunAction;
  readonly error?: string;
  readonly onAction: (action: StudioRunAction) => void;
}

const ACTION_LABELS: Readonly<Record<StudioRunAction, string>> = {
  pause: 'Pause after current work',
  resume: 'Resume',
  cancel: 'Cancel run',
};

export function RunHeader({ view, busyAction, error, onAction }: RunHeaderProps) {
  const actions = visibleRunActions(view);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [objectiveExpanded, setObjectiveExpanded] = useState(false);
  const objective = view.run.objective;
  const hasLongObjective = (objective?.length ?? 0) > 320;
  useEffect(() => {
    setObjectiveExpanded(false);
    setConfirmCancel(false);
  }, [view.run.id]);
  return (
    <>
      <header class="run-header">
        <div class="run-heading">
          <p class="context-label">
            Workflow · revision {view.workflow.logicalRevision}
          </p>
          <h1>{view.workflow.name}</h1>
          {objective && (
            <>
              <p class="run-objective" data-expanded={objectiveExpanded}>{objective}</p>
              {hasLongObjective && (
                <button
                  type="button"
                  class="objective-toggle"
                  aria-expanded={objectiveExpanded}
                  onClick={() => setObjectiveExpanded(expanded => !expanded)}
                >{objectiveExpanded ? 'Collapse objective' : 'Show full objective'}</button>
              )}
            </>
          )}
          <div class="run-facts">
            <span class="status-text" data-state={view.run.status}>{readableState(view.run.status)}</span>
            <span>Started <time dateTime={view.run.createdAt}>{formatTime(view.run.createdAt)}</time></span>
            <span>{view.workflow.profiles && Object.keys(view.workflow.profiles).length} profiles</span>
          </div>
        </div>
        {actions.length > 0 && (
          <div class="run-actions" aria-label="Run controls">
            {actions.filter(action => action !== 'cancel').map(action => (
              <button
                type="button"
                class="button"
                disabled={busyAction !== undefined}
                onClick={() => onAction(action)}
                key={action}
              >
                {busyAction === action ? `${ACTION_LABELS[action]}…` : ACTION_LABELS[action]}
              </button>
            ))}
            {actions.includes('cancel') && !confirmCancel && (
              <button
                type="button"
                class="button button-danger"
                disabled={busyAction !== undefined}
                onClick={() => setConfirmCancel(true)}
              >Cancel run</button>
            )}
          </div>
        )}
        {error && !confirmCancel && <p class="action-error" role="alert">{error}</p>}
      </header>
      {confirmCancel && actions.includes('cancel') && (
        <ConfirmationDialog
          titleId="cancel-run-title"
          title="Cancel this run?"
          description="Queued work will not start. Active provider work is stopped when the provider supports cancellation."
          busy={busyAction !== undefined}
          onClose={() => setConfirmCancel(false)}
          actions={close => (
            <>
              <button class="button" type="button" disabled={busyAction !== undefined} onClick={close}>Keep running</button>
              <button
                class="button button-danger"
                type="button"
                disabled={busyAction !== undefined}
                onClick={() => onAction('cancel')}
              >{busyAction === 'cancel' ? 'Cancelling…' : 'Confirm cancel'}</button>
            </>
          )}
        >
          {error && <p class="action-error" role="alert">{error}</p>}
        </ConfirmationDialog>
      )}
    </>
  );
}
