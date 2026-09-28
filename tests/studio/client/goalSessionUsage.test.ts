import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { goalSessionUsageRows } from '../../../src/studio/client/features/steering/GoalSessionUsage.js';
import type { StudioGoalSessionSummary } from '../../../src/studio/contracts/studio.js';

type GoalUsage = StudioGoalSessionSummary['providerUsage'];

function usage(overrides: Partial<GoalUsage> = {}): GoalUsage {
  return {
    scope: 'permanent-goal-session',
    providerCalls: 2,
    usageReports: 0,
    totals: {},
    fieldReports: {
      estimatedCostUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    turns: [],
    ...overrides,
  };
}

describe('Studio permanent-session usage UI', () => {
  it('renders no numeric usage rows when all provider fields are unknown', () => {
    expect(goalSessionUsageRows(usage())).toEqual([]);
  });

  it('labels per-field coverage and keeps cache and reasoning as breakdowns', () => {
    const rows = goalSessionUsageRows(usage({
      usageReports: 2,
      totals: {
        inputTokens: 125,
        cachedInputTokens: 80,
        reasoningOutputTokens: 9,
      },
      fieldReports: {
        estimatedCostUsd: 0,
        inputTokens: 2,
        cachedInputTokens: 1,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 1,
      },
    }));

    expect(rows).toEqual([
      {
        field: 'inputTokens', label: 'Input tokens', value: '125',
        coverage: '2/2 calls reported this field',
      },
      {
        field: 'cachedInputTokens', label: 'Cached input', value: '80 · breakdown',
        coverage: '1/2 calls reported this field',
      },
      {
        field: 'reasoningOutputTokens', label: 'Reasoning output', value: '9 · breakdown',
        coverage: '1/2 calls reported this field',
      },
    ]);
  });

  it('states the permanent-session scope and keeps call details collapsed', () => {
    const source = fs.readFileSync(path.resolve(
      'src/studio/client/features/steering/GoalSessionUsage.tsx',
    ), 'utf8');

    expect(source).toContain('Permanent-session usage');
    expect(source).toContain('Workflow node attempts are excluded.');
    expect(source).toContain('<details class="technical-details">');
    expect(source).toContain("turn.usage ? 'usage reported' : 'usage not reported'");
  });
});
