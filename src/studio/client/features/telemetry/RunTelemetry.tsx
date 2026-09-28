import type { StudioRunView } from '../../types.js';
import { runTelemetryModel } from './telemetryModel.js';

interface RunTelemetryProps {
  readonly view: StudioRunView;
}

const integer = new Intl.NumberFormat();
const currency = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4,
});

export function RunTelemetry({ view }: RunTelemetryProps) {
  const telemetry = runTelemetryModel(view);
  const headline = telemetry.tokens.filter(token => token.kind === 'headline');
  const breakdown = telemetry.tokens.filter(token => token.kind === 'breakdown');
  return (
    <div class="run-telemetry">
      <section class="telemetry-section" aria-labelledby="telemetry-work-title">
        <header><h3 id="telemetry-work-title">Invocation ledger</h3><p>Durable scheduler counts</p></header>
        <dl class="telemetry-values">
          <div><dt>Model calls</dt><dd>{integer.format(telemetry.modelCalls)}</dd></div>
          <div><dt>Node attempts</dt><dd>{integer.format(telemetry.nodeAttempts)}</dd></div>
        </dl>
      </section>
      <section class="telemetry-section" aria-labelledby="telemetry-usage-title">
        <header>
          <h3 id="telemetry-usage-title">Provider usage</h3>
          <p>{telemetry.usageReports > 0
            ? `Provider reported · ${telemetry.usageCoverage}`
            : 'Usage not reported'}</p>
        </header>
        {telemetry.usageReports === 0 ? (
          <p class="empty-state">No provider token or cost data was reported for these calls.</p>
        ) : (
          <>
            {headline.length > 0 && (
              <dl class="telemetry-values">
                {headline.map(token => (
                  <div key={token.field}>
                    <dt>{token.label}</dt>
                    <dd>{integer.format(token.value)}</dd>
                    <small>{token.reportCount}/{telemetry.modelCalls} model calls reported this field</small>
                  </div>
                ))}
              </dl>
            )}
            {breakdown.length > 0 && (
              <div class="telemetry-breakdown">
                <h4>Reported breakdowns</h4>
                <dl>
                  {breakdown.map(token => (
                    <div key={token.field}>
                      <dt>{token.label}</dt>
                      <dd>{integer.format(token.value)} · {token.reportCount} reports</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {telemetry.providerEstimatedCost && (
              <div class="telemetry-cost">
                <span>Provider estimate</span>
                <strong>{currency.format(telemetry.providerEstimatedCost.value)}</strong>
                <small>{telemetry.providerEstimatedCost.coverage} reported cost</small>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
