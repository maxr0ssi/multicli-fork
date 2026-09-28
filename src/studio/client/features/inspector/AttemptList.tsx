import { formatDuration, formatTime, readableState } from '../../format.js';
import type { StudioNodeAttempt } from '../../types.js';
import type { AttemptUsage } from '../../../../workflows/domain.js';

interface AttemptListProps {
  readonly attempts: readonly StudioNodeAttempt[];
}

const integer = new Intl.NumberFormat();
const currency = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4,
});

export interface ReportedUsageRow {
  readonly field: keyof AttemptUsage;
  readonly label: string;
  readonly value: string;
  readonly kind: 'headline' | 'breakdown' | 'estimate';
}

export function reportedUsageRows(usage?: AttemptUsage): ReportedUsageRow[] {
  if (!usage) return [];
  return [
    usage.inputTokens === undefined ? undefined : {
      field: 'inputTokens', label: 'Input tokens',
      value: integer.format(usage.inputTokens), kind: 'headline',
    },
    usage.outputTokens === undefined ? undefined : {
      field: 'outputTokens', label: 'Output tokens',
      value: integer.format(usage.outputTokens), kind: 'headline',
    },
    usage.cachedInputTokens === undefined ? undefined : {
      field: 'cachedInputTokens', label: 'Cached input',
      value: `${integer.format(usage.cachedInputTokens)} · breakdown`, kind: 'breakdown',
    },
    usage.cacheCreationInputTokens === undefined ? undefined : {
      field: 'cacheCreationInputTokens', label: 'Cache creation input',
      value: `${integer.format(usage.cacheCreationInputTokens)} · breakdown`, kind: 'breakdown',
    },
    usage.reasoningOutputTokens === undefined ? undefined : {
      field: 'reasoningOutputTokens', label: 'Reasoning output',
      value: `${integer.format(usage.reasoningOutputTokens)} · breakdown`, kind: 'breakdown',
    },
    usage.estimatedCostUsd === undefined ? undefined : {
      field: 'estimatedCostUsd', label: 'Provider estimate',
      value: currency.format(usage.estimatedCostUsd), kind: 'estimate',
    },
  ].filter((row): row is ReportedUsageRow => row !== undefined);
}

export function attemptUsageRows(usage?: AttemptUsage): Array<{ label: string; value: string }> {
  return reportedUsageRows(usage).map(({ label, value }) => ({ label, value }));
}

export function AttemptList({ attempts }: AttemptListProps) {
  if (attempts.length === 0) return null;
  return (
    <section class="inspector-section" aria-labelledby="attempts-title">
      <h3 id="attempts-title">Attempts</h3>
      <ol class="attempt-list">
        {attempts.map(attempt => {
          const usageRows = reportedUsageRows(attempt.usage);
          return <li key={attempt.id} class="attempt-row">
            <div class="attempt-heading">
              <strong>Attempt {attempt.number}</strong>
              <span class="status-text" data-state={attempt.status}>{readableState(attempt.status)}</span>
            </div>
            <dl class="fact-list">
              {attempt.startedAt && (
                <div><dt>Started</dt><dd>{formatTime(attempt.startedAt)}</dd></div>
              )}
              {attempt.startedAt && (
                <div><dt>Duration</dt><dd>{formatDuration(attempt.startedAt, attempt.finishedAt)}</dd></div>
              )}
              {attempt.lease && (
                <div>
                  <dt>Heartbeat</dt>
                  <dd class="status-text" data-state={attempt.lease.state === 'active' ? 'running' : 'failed'}>
                    {attempt.lease.state === 'active'
                      ? `Active · renewed ${formatTime(attempt.lease.lastRenewedAt)}`
                      : `Overdue · expired ${formatTime(attempt.lease.expiresAt)}`}
                  </dd>
                </div>
              )}
              <div><dt>Usage</dt><dd>{usageRows.length > 0 ? 'Provider reported' : 'Not reported'}</dd></div>
            </dl>
            {usageRows.length > 0 && (
              <dl class="attempt-usage-list">
                {usageRows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
              </dl>
            )}
            {attempt.error && <p class="attempt-error">{attempt.error}</p>}
          </li>;
        })}
      </ol>
    </section>
  );
}
