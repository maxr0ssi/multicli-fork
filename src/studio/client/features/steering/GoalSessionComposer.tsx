import { useState } from 'preact/hooks';

import { ConfirmationDialog } from '../../components/ConfirmationDialog.js';
import type { StudioActionAvailability, StudioGoalSessionSummary } from '../../types.js';
import { GoalSessionUsage } from './GoalSessionUsage.js';

interface GoalSessionComposerProps {
  readonly session: StudioGoalSessionSummary;
  readonly sendInstruction: StudioActionAvailability;
  readonly onSend: (instruction: string) => Promise<void>;
  readonly onClose: () => Promise<void>;
}

export function GoalSessionComposer({
  session,
  sendInstruction,
  onSend,
  onClose,
}: GoalSessionComposerProps) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmClose, setConfirmClose] = useState(false);
  return (
    <>
      <section class="inspector-section" aria-labelledby={`goal-composer-title-${session.id}`}>
        <div class="inspector-heading">
          <h3 id={`goal-composer-title-${session.id}`}>Continue goal session</h3>
          {session.allowedActions.close.allowed && !confirmClose && (
            <button class="button" type="button" onClick={() => {
              setError(undefined);
              setConfirmClose(true);
            }}>
              Close session
            </button>
          )}
        </div>
        <GoalSessionUsage session={session} />
        {sendInstruction.allowed && <p>This sends a new turn to {session.model}. It does not interrupt an active turn.</p>}
        {sendInstruction.allowed && <form onSubmit={event => {
          event.preventDefault();
          const value = instruction.trim();
          if (!value) return;
          setBusy(true);
          setError(undefined);
          void onSend(value)
            .then(() => setInstruction(''))
            .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
            .finally(() => setBusy(false));
        }}>
          <label class="form-field">
            <span>Instruction</span>
            <textarea value={instruction} onInput={event => setInstruction(event.currentTarget.value)} />
          </label>
          {error && !confirmClose && <p class="action-error" role="alert">{error}</p>}
          <button class="button button-primary" type="submit" disabled={busy || !instruction.trim()}>
            {busy ? 'Sending…' : 'Send next turn'}
          </button>
        </form>}
      </section>
      {confirmClose && session.allowedActions.close.allowed && (
        <ConfirmationDialog
          titleId={`close-goal-title-${session.id}`}
          title="Close this goal session?"
          description="History is preserved, but this session cannot accept another turn."
          busy={busy}
          onClose={() => setConfirmClose(false)}
          actions={close => (
            <>
              <button class="button" type="button" disabled={busy} onClick={close}>Keep open</button>
              <button
                class="button button-danger"
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(undefined);
                  void onClose()
                    .then(() => setConfirmClose(false))
                    .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
                    .finally(() => setBusy(false));
                }}
              >{busy ? 'Closing…' : 'Confirm close'}</button>
            </>
          )}
        >
          {error && <p class="action-error" role="alert">{error}</p>}
        </ConfirmationDialog>
      )}
    </>
  );
}
