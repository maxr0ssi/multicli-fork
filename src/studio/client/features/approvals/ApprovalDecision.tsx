import { useState } from 'preact/hooks';

import { ConfirmationDialog } from '../../components/ConfirmationDialog.js';
import { formatTime, readableState } from '../../format.js';
import type {
  StudioApproval,
  StudioArtifactSummary,
  StudioHarnessEvidence,
} from '../../types.js';

interface ApprovalDecisionProps {
  readonly approvals: readonly StudioApproval[];
  readonly artifacts: readonly StudioArtifactSummary[];
  readonly harness: readonly StudioHarnessEvidence[];
  readonly onResolve: (
    approval: StudioApproval,
    decision: 'approved' | 'denied',
  ) => Promise<void>;
}

export function ApprovalDecision({ approvals, artifacts, harness, onResolve }: ApprovalDecisionProps) {
  const [busyId, setBusyId] = useState<string>();
  const [confirmDenyId, setConfirmDenyId] = useState<string>();
  const [error, setError] = useState<string>();
  const pending = approvals.filter(approval => approval.status === 'pending');
  const denialApproval = pending.find(approval => (
    approval.id === confirmDenyId && approval.resolve.allowed
  ));
  if (pending.length === 0) return null;

  const resolve = async (approval: StudioApproval, decision: 'approved' | 'denied') => {
    setBusyId(approval.id);
    setError(undefined);
    try {
      await onResolve(approval, decision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <>
      <section class="run-section approval-section" aria-labelledby="approval-title">
        <header class="section-heading">
          <div><p class="context-label">Action required</p><h2 id="approval-title">Approval</h2></div>
        </header>
        {pending.map(approval => {
          const context = approval.context.kind === 'workflow-gate' ? approval.context : undefined;
          const outputs = context
            ? artifacts.filter(artifact => context.artifactIds.includes(artifact.id))
            : [];
          const verification = context
            ? harness.filter(result => (
              result.invocationId
              && context.harnessInvocationIds.includes(result.invocationId)
            ))
            : [];
          return (
            <article class="approval-decision" key={approval.id}>
              <div class="approval-context">
                <span class="status-text" data-state="waiting">{approval.risk} risk</span>
                <time dateTime={approval.requestedAt}>Requested {formatTime(approval.requestedAt)}</time>
              </div>
              <h3>{context?.prompt ?? 'Review this workflow decision'}</h3>
              {outputs.length > 0 && (
                <div>
                  <p>Outputs in scope:</p>
                  <ul class="plain-list">{outputs.map(output => <li key={output.id}>{output.name}</li>)}</ul>
                </div>
              )}
              {verification.map(result => (
                <dl class="fact-list approval-verification" key={result.invocationId}>
                  <div>
                    <dt>Verification</dt>
                    <dd class="status-text" data-state={result.outcome === 'pass' ? 'succeeded' : 'failed'}>
                      {readableState(result.outcome)}
                    </dd>
                  </div>
                  <div><dt>Checks</dt><dd>{result.checks.length}</dd></div>
                  {result.findingCount !== undefined && (
                    <div><dt>Findings</dt><dd>{result.findingCount}</dd></div>
                  )}
                </dl>
              ))}
              <details class="technical-details">
                <summary>Technical details</summary>
                <p class="action-hash">Action hash: {approval.actionHash}</p>
              </details>
              {!approval.resolve.allowed && <p class="notice">{approval.resolve.reason}</p>}
              {approval.resolve.allowed && (
                <div class="approval-actions">
                  {confirmDenyId !== approval.id && (
                    <button
                      class="button button-danger"
                      type="button"
                      disabled={busyId !== undefined}
                      onClick={() => {
                        setError(undefined);
                        setConfirmDenyId(approval.id);
                      }}
                    >Deny</button>
                  )}
                  <button
                    class="button button-primary"
                    type="button"
                    disabled={busyId !== undefined}
                    onClick={() => void resolve(approval, 'approved')}
                  >Approve</button>
                </div>
              )}
            </article>
          );
        })}
        {error && !denialApproval && <p class="action-error" role="alert">{error}</p>}
      </section>
      {denialApproval && (
        <ConfirmationDialog
          titleId={`deny-title-${denialApproval.id}`}
          title="Deny this approval?"
          description="The workflow stops at this gate and downstream nodes will not run."
          busy={busyId !== undefined}
          onClose={() => setConfirmDenyId(undefined)}
          actions={close => (
            <>
              <button class="button" type="button" disabled={busyId !== undefined} onClick={close}>Keep waiting</button>
              <button
                class="button button-danger"
                type="button"
                disabled={busyId !== undefined}
                onClick={() => void resolve(denialApproval, 'denied')}
              >{busyId === denialApproval.id ? 'Denying…' : 'Confirm deny'}</button>
            </>
          )}
        >
          {error && <p class="action-error" role="alert">{error}</p>}
        </ConfirmationDialog>
      )}
    </>
  );
}
