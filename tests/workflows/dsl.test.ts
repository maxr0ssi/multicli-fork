import {
  agent,
  approval,
  buildWorkflowTopology,
  createHarmonyDeliveryWorkflow,
  defineWorkflow,
  describeWorkflowApi,
  parallel,
  profiles,
  review,
  sequence,
  validateWorkflowRevision,
  WORKFLOW_API_MANIFEST,
  WorkflowDslError,
} from '../../src/workflows/index.js';

describe('agent-readable workflow DSL', () => {
  it('compiles a sequence with implementation lanes, an Opus council, and final Sol', () => {
    const definition = defineWorkflow({
      id: 'agent-authored-delivery',
      name: 'Agent-authored delivery',
      steps: sequence(
        agent('plan', profiles.sol(), 'Plan {{objective}}.'),
        parallel('build', [
          sequence(
            agent('core', profiles.luna(), 'Build the core.'),
            agent(
              'polish',
              profiles.sonnet({
                id: 'sonnet-builder',
                role: 'builder',
                workspaceAccess: 'workspace-write',
              }),
              'Polish the core.',
            ),
          ),
          agent('specialist', profiles.sonnet(), 'Research edge cases.'),
        ]),
        review('independent-review', {
          prompt: 'Review all artifacts independently.',
          reviewers: [{ profile: profiles.opus(), count: 3 }],
        }),
        agent('final-sol', profiles.sol(), 'Adjudicate all reviews.'),
        approval('release', 'Approve release.'),
      ),
    });

    expect(validateWorkflowRevision(definition)).toEqual({ valid: true, issues: [] });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(definition.profiles.map((profile) => profile.id)).toEqual([
      'sol-conductor',
      'luna-max-builder',
      'sonnet-builder',
      'sonnet-reviewer',
      'opus-reviewer',
    ]);
    expect(definition.profiles).not.toContainEqual(expect.objectContaining({ model: 'gpt-5.6-terra' }));
    expect(definition.profiles.find((profile) => profile.id === 'sonnet-reviewer'))
      .toMatchObject({ model: 'claude-sonnet-5', reasoningEffort: 'high' });
    expect(definition.profiles.find((profile) => profile.id === 'opus-reviewer'))
      .toMatchObject({ model: 'claude-opus-5', reasoningEffort: 'high' });

    const topology = buildWorkflowTopology(definition);
    expect(topology.outgoing.get('plan')).toEqual(['build--fanout']);
    expect(topology.outgoing.get('build--fanout')).toEqual(['core', 'specialist']);
    expect(topology.incoming.get('build--join')).toEqual(['polish', 'specialist']);
    expect(topology.outgoing.get('independent-review--fanout')).toEqual([
      'independent-review--reviewer-1',
      'independent-review--reviewer-2',
      'independent-review--reviewer-3',
    ]);
    expect(topology.outgoing.get('independent-review--join')).toEqual(['final-sol']);
    expect(topology.outgoing.get('final-sol')).toEqual(['release']);
    expect(topology.outgoing.get('release')).toEqual(['complete']);
  });

  it('ships the preferred Harmony topology with Luna/MAX default and explicit alternatives', () => {
    const definition = createHarmonyDeliveryWorkflow({ lunaBuilders: 2, opusReviewers: 2 });

    expect(validateWorkflowRevision(definition).valid).toBe(true);
    expect(definition.nodes.filter(
      (node) => node.kind === 'agent' && node.profileId === 'luna-max-builder',
    )).toHaveLength(2);
    expect(definition.nodes.filter(
      (node) => node.kind === 'agent' && node.profileId === 'opus-reviewer',
    )).toHaveLength(2);
    expect(definition.nodes.at(-2)).toMatchObject({ id: 'ship-approval', kind: 'gate' });
    expect(definition.metadata).toMatchObject({
      defaultBuilder: 'luna-max',
      terraRouting: 'explicit-only',
      hiddenFallbacks: 'disabled',
    });
    expect(definition.profiles.some((profile) => profile.model === 'gpt-5.6-terra')).toBe(false);
    expect(definition.profiles.find((profile) => profile.id === 'opus-reviewer'))
      .toMatchObject({ model: 'claude-opus-5', reasoningEffort: 'high' });
  });

  it('requires deliberate Terra selection and never weakens fixed profile policy', () => {
    const terra = profiles.terra({ workspaceAccess: 'workspace-write', role: 'builder' });
    const luna = profiles.luna();
    const delegatedLuna = profiles.luna({ id: 'delegated-luna', enableSubagents: true });

    expect(terra.selection).toBe('explicit-only');
    expect(terra.workspaceAccess).toBe('workspace-write');
    expect(luna.selection).toBe('default');
    expect(luna.reasoningEffort).toBe('max');
    expect(luna.enableSubagents).toBe(false);
    expect(delegatedLuna.enableSubagents).toBe(true);
    expect('fable' in profiles).toBe(false);
  });

  it('preflights exact model-family caps before execution', () => {
    const repeated = (
      count: number,
      prefix: string,
      profile: ReturnType<typeof profiles.luna>,
    ) => Array.from({ length: count }, (_, index) => (
      agent(`${prefix}-${index + 1}`, profile, 'Review the workflow.')
    ));

    expect(() => defineWorkflow({
      id: 'twenty-lunas',
      name: 'Twenty Lunas',
      steps: sequence(...repeated(20, 'luna', profiles.luna())),
    })).not.toThrow();
    expect(() => defineWorkflow({
      id: 'twenty-one-lunas',
      name: 'Twenty-one Lunas',
      steps: sequence(...repeated(21, 'luna', profiles.luna())),
    })).toThrow(/preflight cap is 20/i);

    expect(() => defineWorkflow({
      id: 'six-opus',
      name: 'Six Opus reviewers',
      steps: sequence(review('review', {
        prompt: 'Review.',
        reviewers: [{ profile: profiles.opus(), count: 6 }],
      })),
    })).toThrow(/between one and 5/i);
    expect(() => defineWorkflow({
      id: 'four-sol',
      name: 'Four Sol conductors',
      steps: sequence(...repeated(4, 'sol', profiles.sol())),
    })).toThrow(/preflight cap is 3/i);

    const fable = {
      ...profiles.terra({ id: 'blocked-fable' }),
      model: 'gpt-5.6-fable',
    };
    expect(() => defineWorkflow({
      id: 'no-fable',
      name: 'No Fable',
      steps: sequence(agent('fable', fable, 'Do not run.')),
    })).toThrow(/preflight cap is 0/i);
  });

  it('rejects ambiguous or structurally invalid authoring input early', () => {
    expect(() => defineWorkflow({
      id: 'one-lane',
      name: 'One lane',
      steps: sequence(parallel('bad', [agent('only', profiles.luna(), 'Work.')])),
    })).toThrow(/at least two lanes/i);

    expect(() => defineWorkflow({
      id: 'one-reviewer',
      name: 'One reviewer',
      steps: sequence(review('bad-review', {
        prompt: 'Review.',
        reviewers: [{ profile: profiles.opus() }],
      })),
    })).toThrow(/at least two reviewers/i);

    expect(() => defineWorkflow({
      id: 'conflicting-profiles',
      name: 'Conflicting profiles',
      steps: sequence(
        agent('first', profiles.sol(), 'One.'),
        agent('second', profiles.sol({ workspaceAccess: 'workspace-write' }), 'Two.'),
      ),
    })).toThrow(WorkflowDslError);
  });

  it('exposes a frozen machine-readable topology and routing manifest', () => {
    expect(describeWorkflowApi()).toBe(WORKFLOW_API_MANIFEST);
    expect(Object.isFrozen(WORKFLOW_API_MANIFEST)).toBe(true);
    expect(Object.isFrozen(WORKFLOW_API_MANIFEST.profiles.terra)).toBe(true);
    expect(WORKFLOW_API_MANIFEST).toMatchObject({
      primitives: ['sequence', 'agent', 'parallel', 'review', 'approval'],
      policy: {
        defaultBuilder: 'luna',
        defaultBuilderReasoningEffort: 'max',
        terraRouting: 'explicit-only',
        hiddenFallbacks: false,
        preflightRequired: true,
        defaultConcurrency: 5,
        agentCaps: { default: 5, luna: 20, opus: 5, sol: 3, fable: 0 },
        subagentsDefault: false,
        fableRouting: 'disabled',
      },
      locality: {
        execution: 'local-provider-cli',
        externalModelApiKeysRequired: false,
      },
    });
  });
});
