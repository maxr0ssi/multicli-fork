import { ConfirmationDialog } from '../../components/ConfirmationDialog.js';

interface DraftRecoveryDialogProps {
  readonly busy: boolean;
  readonly conflict: boolean;
  readonly error?: string;
  readonly onSaveAsNewDraft: () => void;
  readonly onReload: () => void;
  readonly onCloseWithoutSaving: () => void;
  readonly onClose: () => void;
}

export function DraftRecoveryDialog({
  busy,
  conflict,
  error,
  onSaveAsNewDraft,
  onReload,
  onCloseWithoutSaving,
  onClose,
}: DraftRecoveryDialogProps) {
  const description = conflict
    ? 'Another editor saved first. Your local edits are intact; preserve them in a new durable draft or reload the other edits.'
    : 'Reload fetches the current saved draft. Closing leaves that saved version unchanged.';
  return (
    <ConfirmationDialog
      titleId="recover-draft-title"
      title={conflict ? 'Keep both sets of changes?' : 'Discard unsaved changes?'}
      description={description}
      busy={busy}
      onClose={onClose}
      actions={close => (
        <>
          <button class="button" type="button" disabled={busy} onClick={close}>Keep editing</button>
          {conflict && (
            <button class="button button-primary" type="button" disabled={busy} onClick={onSaveAsNewDraft}>
              Save my changes as a new draft
            </button>
          )}
          <button class="button" type="button" disabled={busy} onClick={onReload}>Reload saved draft</button>
          <button class="button button-danger" type="button" disabled={busy} onClick={onCloseWithoutSaving}>
            Close without saving
          </button>
        </>
      )}
    >
      {error && <p class="action-error" role="alert">{error}</p>}
    </ConfirmationDialog>
  );
}
