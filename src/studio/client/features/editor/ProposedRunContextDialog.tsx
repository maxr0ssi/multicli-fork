import { FocusDialog } from '../../components/FocusDialog.js';

interface ProposedRunContextDialogProps {
  readonly workflowName: string;
  readonly value: unknown;
  readonly onClose: () => void;
}

export function formatProposedRunContext(value: unknown): string {
  const formatted = JSON.stringify(value, null, 2);
  return formatted ?? String(value);
}

export function ProposedRunContextDialog({
  workflowName,
  value,
  onClose,
}: ProposedRunContextDialogProps) {
  return (
    <FocusDialog
      titleId="proposed-run-context-title"
      title="Proposed run context"
      context={`${workflowName} · read-only persisted input`}
      className="run-context-dialog"
      onClose={onClose}
    >
      <section class="run-context-preview" aria-labelledby="run-context-value-title">
        <div>
          <h3 id="run-context-value-title">Exact run input</h3>
          <p>Publish and run sends this complete value unchanged. Edit the objective from the publish confirmation.</p>
        </div>
        <pre tabIndex={0}><code>{formatProposedRunContext(value)}</code></pre>
      </section>
    </FocusDialog>
  );
}
