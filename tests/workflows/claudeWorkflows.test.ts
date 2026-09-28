import { describe, expect, it } from 'vitest';

import {
  createClaudeDeepDeliveryWorkflow,
  createClaudeDeepThinkWorkflow,
  validateWorkflowRevision,
} from '../../src/workflows/index.js';

describe('Claude workflow presets', () => {
  it('keeps the thinking workflow read-only and nested delegation off by default', () => {
    const workflow = createClaudeDeepThinkWorkflow();

    expect(validateWorkflowRevision(workflow).valid).toBe(true);
    expect(workflow.profiles).toHaveLength(1);
    expect(workflow.profiles[0]).toMatchObject({
      provider: 'claude',
      workspaceAccess: 'read-only',
      enableSubagents: false,
    });
    expect(workflow.nodes.filter(node => node.kind === 'agent')).toHaveLength(4);
  });

  it('makes delivery writes explicit and preserves the Opus family cap', () => {
    const workflow = createClaudeDeepDeliveryWorkflow({ enableSubagents: true });
    const opusNodes = workflow.nodes.filter(node => (
      node.kind === 'agent' && node.profileId.includes('opus')
    ));
    const writers = workflow.profiles.filter(profile => profile.workspaceAccess === 'workspace-write');

    expect(validateWorkflowRevision(workflow).valid).toBe(true);
    expect(opusNodes).toHaveLength(4);
    expect(writers).toHaveLength(1);
    expect(workflow.profiles.find(profile => profile.provider === 'claude' && profile.model.includes('opus')))
      .toMatchObject({ enableSubagents: true });
  });
});
