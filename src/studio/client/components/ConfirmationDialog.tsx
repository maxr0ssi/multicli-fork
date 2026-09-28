import type { ComponentChildren } from 'preact';

import { useModalDialog } from '../useModalDialog.js';

interface ConfirmationDialogProps {
  readonly titleId: string;
  readonly title: string;
  readonly description: string;
  readonly busy?: boolean;
  readonly children?: ComponentChildren;
  readonly actions: (close: () => void) => ComponentChildren;
  readonly onClose: () => void;
}

/** Compact native modal confirmation; showModal supplies focus containment and inertness. */
export function ConfirmationDialog({
  titleId,
  title,
  description,
  busy = false,
  children,
  actions,
  onClose,
}: ConfirmationDialogProps) {
  const dialog = useModalDialog();
  const close = () => dialog.current?.close();
  return (
    <dialog
      ref={dialog}
      class="workflow-dialog confirmation-dialog"
      aria-labelledby={titleId}
      aria-describedby={`${titleId}-description`}
      onCancel={event => { if (busy) event.preventDefault(); }}
      onClose={onClose}
    >
      <div class="confirmation-dialog-content">
        <header>
          <h2 id={titleId}>{title}</h2>
          <p id={`${titleId}-description`}>{description}</p>
        </header>
        {children}
        <div class="dialog-actions">{actions(close)}</div>
      </div>
    </dialog>
  );
}
