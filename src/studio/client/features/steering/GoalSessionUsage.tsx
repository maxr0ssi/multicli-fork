import type { StudioGoalSessionSummary } from '../../types.js';
import { reportedUsageRows } from '../inspector/AttemptList.js';

interface GoalSessionUsageProps {
  readonly session: StudioGoalSessionSummary;
}

export interface GoalSessionUsageRow {
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly coverage: string;
}

export function goalSessionUsageRows(
  usage: StudioGoalSessionSummary['providerUsage'],
): GoalSessionUsageRow[] {
  return reportedUsageRows(usage.totals).map(row => ({
    field: row.field,
    label: row.label,
    value: row.value,
    coverage: `${usage.fieldReports[row.field]}/${usage.providerCalls} calls reported this field`,
  }));
}

function outcomeLabel(outcome: StudioGoalSessionSummary['providerUsage']['turns'][number]['outcome']) {
  if (outcome === 'succeeded') return 'Succeeded';
  if (outcome === 'blocked') return 'Session blocked';
  return 'Failed';
}

export function GoalSessionUsage({ session }: GoalSessionUsageProps) {
  const usage = session.providerUsage;
  const rows = goalSessionUsageRows(usage);
  return (
    <section class="goal-session-usage" aria-labelledby={`goal-usage-title-${session.id}`}>
      <h4 id={`goal-usage-title-${session.id}`}>Permanent-session usage</h4>
      <p>Scope: this pinned goal session only. Workflow node attempts are excluded.</p>
      <dl class="fact-list">
        <div><dt>Provider calls</dt><dd>{usage.providerCalls}</dd></div>
        <div>
          <dt>Usage coverage</dt>
          <dd>{usage.usageReports}/{usage.providerCalls} calls reported usage</dd>
        </div>
      </dl>
      {usage.providerCalls === 0 && (
        <p class="empty-state">No permanent-session provider calls recorded.</p>
      )}
      {usage.providerCalls > 0 && usage.usageReports === 0 && (
        <p class="empty-state">Token and cost fields were not reported for these calls.</p>
      )}
      {rows.length > 0 && (
        <dl class="attempt-usage-list">
          {rows.map(row => (
            <div key={row.field}>
              <dt>{row.label}<small>{row.coverage}</small></dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {usage.turns.length > 0 && (
        <details class="technical-details">
          <summary>Call-by-call coverage</summary>
          <ol class="plain-list">
            {usage.turns.map((turn, index) => (
              <li key={turn.artifactId}>
                Call {index + 1} · turn {turn.turnNumber} · {outcomeLabel(turn.outcome)}
                {turn.resumed === true ? ' · resumed' : turn.resumed === false ? ' · started' : ''}
                {' · '}{turn.usage ? 'usage reported' : 'usage not reported'}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
