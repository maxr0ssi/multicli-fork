import { describe, expect, it } from 'vitest';

import { runTelemetryModel } from '../../../src/studio/client/features/telemetry/telemetryModel.js';
import type { StudioRunView } from '../../../src/studio/contracts/studio.js';
import type { AttemptUsage, BudgetUsage } from '../../../src/workflows/domain.js';

function view(usage: BudgetUsage, reports: readonly AttemptUsage[]): StudioRunView {
  return {
    execution: {
      budget: { usage },
      nodes: {
        agent: {
          attempts: reports.map((report, index) => ({ id: `attempt-${index}`, usage: report })),
        },
      },
    },
  } as unknown as StudioRunView;
}

function usage(overrides: Partial<BudgetUsage> = {}): BudgetUsage {
  return {
    modelCalls: 3,
    nodeAttempts: 4,
    usageReports: 0,
    estimatedCostUsd: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    ...overrides,
  };
}

describe('Studio run telemetry model', () => {
  it('reports unknown provider usage without fabricating zero token or cost values', () => {
    const model = runTelemetryModel(view(usage(), []));

    expect(model).toMatchObject({
      modelCalls: 3,
      nodeAttempts: 4,
      usageReports: 0,
      usageCoverage: '0/3 model calls',
      tokens: [],
    });
    expect(model.providerEstimatedCost).toBeUndefined();
  });

  it('shows only token fields actually reported and keeps cache values as breakdowns', () => {
    const model = runTelemetryModel(view(usage({
      usageReports: 1,
      inputTokens: 12_000,
      cachedInputTokens: 9_000,
      outputTokens: 640,
      reasoningOutputTokens: 510,
    }), [{
      inputTokens: 12_000,
      cachedInputTokens: 9_000,
      outputTokens: 640,
      reasoningOutputTokens: 510,
    }]));

    expect(model.usageCoverage).toBe('1/3 model calls');
    expect(model.tokens.map(token => [token.field, token.kind, token.value])).toEqual([
      ['inputTokens', 'headline', 12_000],
      ['outputTokens', 'headline', 640],
      ['cachedInputTokens', 'breakdown', 9_000],
      ['reasoningOutputTokens', 'breakdown', 510],
    ]);
    expect(model.providerEstimatedCost).toBeUndefined();
  });

  it('shows provider-estimated cost only with its independent report coverage', () => {
    const model = runTelemetryModel(view(usage({
      usageReports: 2,
      estimatedCostUsd: 0.018,
      outputTokens: 10,
    }), [{ outputTokens: 10 }, { estimatedCostUsd: 0.018 }]));

    expect(model.providerEstimatedCost).toEqual({
      value: 0.018,
      coverage: '1/3 model calls',
    });
  });
});
