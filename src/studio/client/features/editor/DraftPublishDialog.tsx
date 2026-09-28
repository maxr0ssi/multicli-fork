import { ConfirmationDialog } from '../../components/ConfirmationDialog.js';

interface DraftPublishDialogProps {
  readonly objective: string;
  readonly unavailableAgents: number;
  readonly busy: boolean;
  readonly error?: string;
  readonly onObjectiveChange: (value: string) => void;
  readonly onPublish: () => void;
  readonly onPublishAndRun: () => void;
  readonly onClose: () => void;
}

export function DraftPublishDialog({
  objective,
  unavailableAgents,
  busy,
  error,
  onObjectiveChange,
  onPublish,
  onPublishAndRun,
  onClose,
}: DraftPublishDialogProps) {
  return (
    <ConfirmationDialog
      titleId="publish-draft-title"
      title="Publish this workflow?"
      description="This creates an immutable workflow revision. Existing runs will not change."
      busy={busy}
      onClose={onClose}
      actions={close => (
        <>
          <button class="button" type="button" disabled={busy} onClick={close}>Keep editing</button>
          <button class="button" type="button" disabled={busy} onClick={onPublish}>
            {busy ? 'Publishing…' : 'Publish only'}
          </button>
          <button
            class="button button-primary"
            type="button"
            disabled={busy || !objective.trim() || unavailableAgents > 0}
            onClick={onPublishAndRun}
          >{busy ? 'Publishing…' : 'Publish and run'}</button>
        </>
      )}
    >
      <label class="form-field draft-publish-objective">
        <span>First run objective</span>
        <textarea
          value={objective}
          placeholder="Optional when publishing without a run"
          onInput={event => onObjectiveChange(event.currentTarget.value)}
          autofocus
        />
        {unavailableAgents > 0 && (
          <small>{unavailableAgents} agent{unavailableAgents === 1 ? '' : 's'} use an unavailable provider CLI.</small>
        )}
      </label>
      {error && <p class="action-error" role="alert">{error}</p>}
    </ConfirmationDialog>
  );
}
