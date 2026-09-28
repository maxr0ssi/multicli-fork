import { describe, expect, it } from 'vitest';

import { renderWorkflowRunContext } from '../../src/workflows/runContext.js';

describe('workflow run context', () => {
  it('renders every JSON-safe proposed field deterministically', () => {
    const input = {
      objective: 'Ship the swarm editor',
      acceptanceCriteria: ['Keyboard editing', 'Exact usage counts'],
      constraints: ['Local CLIs only'],
      context: { repository: 'multicli', priority: 1 },
      extraDecision: { reviewers: ['opus', 'sol'] },
    };

    const rendered = renderWorkflowRunContext(input);

    expect(JSON.parse(rendered)).toEqual(input);
    expect(rendered.indexOf('"acceptanceCriteria"')).toBeLessThan(
      rendered.indexOf('"objective"'),
    );
    expect(rendered).toContain('"extraDecision"');
  });

  it('renders an absent run input as explicit null', () => {
    expect(renderWorkflowRunContext(undefined)).toBe('null');
  });
});
