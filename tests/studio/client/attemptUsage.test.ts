import { describe, expect, it } from 'vitest';

import { attemptUsageRows } from '../../../src/studio/client/features/inspector/AttemptList.js';

describe('Studio attempt usage', () => {
  it('renders no numerical rows when the provider did not report usage', () => {
    expect(attemptUsageRows()).toEqual([]);
    expect(attemptUsageRows({})).toEqual([]);
  });

  it('keeps cache and reasoning fields labelled as breakdowns', () => {
    expect(attemptUsageRows({
      inputTokens: 12_000,
      cachedInputTokens: 9_000,
      reasoningOutputTokens: 510,
    })).toEqual([
      { label: 'Input tokens', value: '12,000' },
      { label: 'Cached input', value: '9,000 · breakdown' },
      { label: 'Reasoning output', value: '510 · breakdown' },
    ]);
  });

  it('does not fabricate cost from token-only usage but retains a reported zero estimate', () => {
    expect(attemptUsageRows({ outputTokens: 20 }).map(row => row.label))
      .not.toContain('Provider estimate');
    expect(attemptUsageRows({ estimatedCostUsd: 0 }).map(row => row.label))
      .toContain('Provider estimate');
  });
});
