import type { ComponentChildren } from 'preact';

import { useModalDialog } from '../useModalDialog.js';

interface FocusDialogProps {
  readonly titleId: string;
  readonly title: string;
  readonly context?: string;
  readonly className?: string;
  readonly actions?: ComponentChildren;
  readonly closeDisabled?: boolean;
  readonly children: ComponentChildren;
  readonly onClose: () => void;
}

/** One full-screen task surface with native modal focus containment. */
export function FocusDialog({
  titleId,
  title,
  context,
  className,
  actions,
  closeDisabled = false,
  children,
  onClose,
}: FocusDialogProps) {
  const dialog = useModalDialog();
  return (
    <dialog
      ref={dialog}
      class={`focus-dialog${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
      onCancel={event => {
        if (closeDisabled) event.preventDefault();
      }}
      onClose={onClose}
    >
      <header class="focus-dialog-heading">
        <div>
          {context && <p class="context-label">{context}</p>}
          <h2 id={titleId}>{title}</h2>
        </div>
        <div class="focus-dialog-actions">
          {actions}
          <button
            class="button"
            type="button"
            disabled={closeDisabled}
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </div>
      </header>
      <div class="focus-dialog-body">{children}</div>
    </dialog>
  );
}
