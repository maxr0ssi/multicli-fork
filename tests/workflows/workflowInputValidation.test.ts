import { describe, expect, it } from 'vitest';

import { validateLocalWorkflowRevision } from '../../src/workflows/localModelPolicy.js';
import { validateWorkflowRevision } from '../../src/workflows/graph.js';
import { LUNA_BUILD_COUNCIL } from '../../src/workflows/lunaBuildCouncil.js';

function mutableWorkflow(): any {
  return structuredClone(LUNA_BUILD_COUNCIL);
}

describe('untrusted workflow input validation', () => {
  it('fully checks profile enums, booleans, provider permissions, and effort', () => {
    const cases: Array<(workflow: any) => void> = [
      workflow => { workflow.profiles[0].role = 'wizard'; },
      workflow => { workflow.profiles[0].workspaceAccess = 'root'; },
      workflow => { workflow.profiles[0].selection = 'sometimes'; },
      workflow => { workflow.profiles[0].enableSubagents = 'yes'; },
      workflow => { workflow.profiles[0].reasoningEffort = 'infinite'; },
      workflow => { workflow.profiles[0].provider = 'remote-api'; },
      workflow => {
        const claude = workflow.profiles.find((profile: any) => profile.provider === 'claude');
        claude.workspaceAccess = 'danger-full-access';
      },
      workflow => {
        const claude = workflow.profiles.find((profile: any) => profile.provider === 'claude');
        claude.reasoningEffort = 'infinite';
      },
      workflow => {
        const luna = workflow.profiles.find((profile: any) => profile.model.includes('luna'));
        luna.reasoningEffort = 'ultra';
      },
      workflow => {
        const terra = workflow.profiles.find((profile: any) => profile.model.includes('terra'));
        terra.selection = 'default';
      },
      workflow => { workflow.profiles[0].model = 'gpt-5.6-fable'; },
    ];

    for (const mutate of cases) {
      const workflow = mutableWorkflow();
      mutate(workflow);
      expect(validateWorkflowRevision(workflow)).toMatchObject({
        valid: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid-profile' })]),
      });
    }
  });

  it('accepts supported Claude 5 thinking levels', () => {
    const workflow = mutableWorkflow();
    const opus = workflow.profiles.find((profile: any) => profile.model === 'claude-opus-5');
    const sonnet = workflow.profiles.find((profile: any) => profile.model === 'claude-sonnet-5');
    opus.reasoningEffort = 'max';
    sonnet.reasoningEffort = 'xhigh';

    expect(validateLocalWorkflowRevision(workflow)).toEqual({ valid: true, issues: [] });
  });

  it('rejects catalogued legacy models outside the current workflow allowlist', () => {
    const workflow = mutableWorkflow();
    workflow.profiles[0].model = 'gpt-5.4';

    expect(validateLocalWorkflowRevision(workflow)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid-profile' })]),
    });
  });

  it('checks gate prompts, labels, metadata, and typed budget limits', () => {
    const workflow = mutableWorkflow();
    workflow.nodes.find((node: any) => node.kind === 'gate').prompt = '';
    workflow.nodes[0].label = 'x'.repeat(161);
    workflow.metadata.bad = 42;
    workflow.budget.maxModelCalls = 1.5;
    workflow.budget.surprise = 3;

    const codes = validateWorkflowRevision(workflow).issues.map(issue => issue.code);
    expect(codes).toEqual(expect.arrayContaining([
      'invalid-node',
      'invalid-metadata',
      'invalid-budget',
    ]));
  });

  it('adds the checked-in local model catalog to publish-time validation', () => {
    const workflow = mutableWorkflow();
    workflow.profiles[0].model = 'gpt-never-catalogued';

    expect(validateWorkflowRevision(workflow).valid).toBe(true);
    expect(validateLocalWorkflowRevision(workflow)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-profile' }),
      ]),
    });
  });
});
