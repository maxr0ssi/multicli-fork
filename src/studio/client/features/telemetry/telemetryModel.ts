import type { AttemptUsage } from '../../../../workflows/domain.js';
import type { StudioRunView } from '../../types.js';

export type ReportedTokenField = Exclude<keyof AttemptUsage, 'estimatedCostUsd'>;

export interface TelemetryTokenValue {
  readonly field: ReportedTokenField;
  readonly label: string;
  readonly value: number;
  readonly reportCount: number;
  readonly kind: 'headline' | 'breakdown';
}

export interface RunTelemetryModel {
  readonly modelCalls: number;
  readonly nodeAttempts: number;
  readonly usageReports: number;
  readonly usageCoverage: string;
  readonly tokens: readonly TelemetryTokenValue[];
  readonly providerEstimatedCost?: {
    readonly value: number;
    readonly coverage: string;
  };
}

const TOKEN_FIELDS: readonly {
  field: ReportedTokenField;
  label: string;
  kind: TelemetryTokenValue['kind'];
}[] = [
  { field: 'inputTokens', label: 'Input tokens', kind: 'headline' },
  { field: 'outputTokens', label: 'Output tokens', kind: 'headline' },
  { field: 'cachedInputTokens', label: 'Cached input', kind: 'breakdown' },
  { field: 'cacheCreationInputTokens', label: 'Cache creation input', kind: 'breakdown' },
  { field: 'reasoningOutputTokens', label: 'Reasoning output', kind: 'breakdown' },
];

export function runTelemetryModel(view: StudioRunView): RunTelemetryModel {
  const aggregate = view.execution.budget.usage;
  const attempts = Object.values(view.execution.nodes).flatMap(node => node.attempts);
  const reportCount = (field: keyof AttemptUsage) => attempts.filter(attempt => (
    attempt.usage?.[field] !== undefined
  )).length;
  const tokens = aggregate.usageReports > 0
    ? TOKEN_FIELDS.flatMap(item => {
      const count = reportCount(item.field);
      return count > 0 ? [{
        ...item,
        value: aggregate[item.field],
        reportCount: count,
      }] : [];
    })
    : [];
  const costReports = reportCount('estimatedCostUsd');
  return {
    modelCalls: aggregate.modelCalls,
    nodeAttempts: aggregate.nodeAttempts,
    usageReports: aggregate.usageReports,
    usageCoverage: `${aggregate.usageReports}/${aggregate.modelCalls} model calls`,
    tokens,
    ...(costReports > 0
      ? {
        providerEstimatedCost: {
          value: aggregate.estimatedCostUsd,
          coverage: `${costReports}/${aggregate.modelCalls} model calls`,
        },
      }
      : {}),
  };
}
