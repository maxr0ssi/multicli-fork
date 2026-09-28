import {
  createInitialRun,
  createLunaBuildCouncilDefinition,
  defineWorkflowRevision,
  reduceRunEvent,
  validateWorkflowRevision,
  DEFAULT_COUNCIL_PROFILES,
  ALTERNATIVE_WORKFLOW_PROFILES,
  LUNA_BUILD_COUNCIL,
  LUNA_MAX_BUILDER_PROFILE,
  SOL_CONDUCTOR_PROFILE,
  TERRA_EXPLICIT_ONLY_PROFILE,
  type RunRecord,
} from '../../src/workflows/index.js';

const AT = '2026-08-09T12:00:00.000Z';

function startRun(run: RunRecord): RunRecord {
  return reduceRunEvent(run, LUNA_BUILD_COUNCIL, {
    id: 'event-run-started',
    type: 'run.started',
    at: AT,
  });
}

function startAndSucceed(
  run: RunRecord,
  nodeId: string,
  attemptId: string,
): RunRecord {
  const started = reduceRunEvent(run, LUNA_BUILD_COUNCIL, {
    id: `event-${attemptId}-started`,
    type: 'node.started',
    nodeId,
    attemptId,
    at: AT,
  });
  return reduceRunEvent(started, LUNA_BUILD_COUNCIL, {
    id: `event-${attemptId}-succeeded`,
    type: 'node.succeeded',
    nodeId,
    attemptId,
    at: AT,
    usage: { estimatedCostUsd: 1, inputTokens: 10, outputTokens: 20 },
    summary: `${nodeId} completed`,
  });
}

describe('Luna Build Council workflow domain', () => {
  it('ships immutable Luna/MAX, Sol, and explicit-only Terra profiles', () => {
    expect(Object.isFrozen(LUNA_BUILD_COUNCIL)).toBe(true);
    expect(Object.isFrozen(LUNA_BUILD_COUNCIL.nodes)).toBe(true);
    expect(Object.isFrozen(LUNA_MAX_BUILDER_PROFILE)).toBe(true);
    expect(LUNA_MAX_BUILDER_PROFILE.model).toBe('gpt-5.6-luna');
    expect(LUNA_MAX_BUILDER_PROFILE.reasoningEffort).toBe('max');
    expect(SOL_CONDUCTOR_PROFILE.model).toBe('gpt-5.6-sol');
    expect(TERRA_EXPLICIT_ONLY_PROFILE.model).toBe('gpt-5.6-terra');
    expect(TERRA_EXPLICIT_ONLY_PROFILE.selection).toBe('explicit-only');
    expect(DEFAULT_COUNCIL_PROFILES.map((profile) => profile.id)).not.toContain(
      TERRA_EXPLICIT_ONLY_PROFILE.id,
    );
    expect(ALTERNATIVE_WORKFLOW_PROFILES.map(profile => profile.id)).toEqual([
      'sonnet-reviewer',
      'opus-reviewer',
      'terra-explicit-only',
    ]);
    expect(ALTERNATIVE_WORKFLOW_PROFILES.every(
      profile => profile.selection === 'explicit-only',
    )).toBe(true);
    expect(validateWorkflowRevision(LUNA_BUILD_COUNCIL)).toEqual({ valid: true, issues: [] });
  });

  it('validates structural graph requirements before a run starts', () => {
    const invalid = defineWorkflowRevision({
      ...LUNA_BUILD_COUNCIL,
      id: 'invalid-council',
      edges: LUNA_BUILD_COUNCIL.edges.filter((edge) => edge.from !== 'dispatch-luna-council'),
    });

    const validation = validateWorkflowRevision(invalid);
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toContain('fanout-needs-branches');
    expect(() => createInitialRun(invalid, { id: 'invalid-run', createdAt: AT })).toThrow(/invalid workflow/i);
  });

  it('returns validation issues for a non-graph durable definition instead of throwing', () => {
    const harnessRevision = {
      id: 'multicli-repository-harness',
      name: 'Multi-CLI repository harness',
      trigger: 'manual',
      checks: [],
    };

    expect(() => validateWorkflowRevision(harnessRevision)).not.toThrow();
    expect(validateWorkflowRevision(harnessRevision)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-revision' }),
        expect.objectContaining({ code: 'invalid-profile' }),
        expect.objectContaining({ code: 'invalid-node' }),
        expect.objectContaining({ code: 'invalid-edge' }),
      ]),
    });
  });

  it('rejects node identifiers that could escape an artifact directory', () => {
    const invalid = defineWorkflowRevision({
      ...LUNA_BUILD_COUNCIL,
      id: 'unsafe-node-id',
      nodes: LUNA_BUILD_COUNCIL.nodes.map(node => (
        node.id === 'sol-conductor' ? { ...node, id: '../../escaped-review' } : node
      )),
      edges: LUNA_BUILD_COUNCIL.edges.map(edge => ({
        from: edge.from === 'sol-conductor' ? '../../escaped-review' : edge.from,
        to: edge.to === 'sol-conductor' ? '../../escaped-review' : edge.to,
      })),
    });

    expect(validateWorkflowRevision(invalid)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: 'invalid-node', nodeId: '../../escaped-review' })],
    });
  });

  it('runs Sol -> fanout -> Luna council -> join -> Sol synthesis -> gate -> end deterministically', () => {
    const initial = createInitialRun(LUNA_BUILD_COUNCIL, { id: 'run-council', createdAt: AT });
    const run = startRun(initial);

    expect(initial.status).toBe('queued');
    expect(initial.nodeStates['sol-conductor'].status).toBe('pending');
    expect(run.status).toBe('running');
    expect(run.nodeStates['sol-conductor'].status).toBe('ready');

    let current = startAndSucceed(run, 'sol-conductor', 'sol-attempt-1');
    expect(current.nodeStates['dispatch-luna-council'].status).toBe('succeeded');
    expect(current.nodeStates['luna-builder-1'].status).toBe('ready');
    expect(current.nodeStates['luna-builder-2'].status).toBe('ready');
    expect(current.nodeStates['luna-builder-3'].status).toBe('ready');
    expect(current.nodeStates['luna-builder-4'].status).toBe('ready');
    expect(current.nodeStates['luna-builder-5'].status).toBe('ready');

    current = startAndSucceed(current, 'luna-builder-1', 'luna-1-attempt-1');
    current = startAndSucceed(current, 'luna-builder-2', 'luna-2-attempt-1');
    current = startAndSucceed(current, 'luna-builder-3', 'luna-3-attempt-1');
    current = startAndSucceed(current, 'luna-builder-4', 'luna-4-attempt-1');
    current = startAndSucceed(current, 'luna-builder-5', 'luna-5-attempt-1');

    expect(current.nodeStates['join-luna-council'].status).toBe('succeeded');
    expect(current.nodeStates['sol-synthesis'].status).toBe('ready');
    expect(current.nodeStates['review-gate'].status).toBe('pending');

    current = startAndSucceed(current, 'sol-synthesis', 'sol-synthesis-attempt-1');
    expect(current.nodeStates['review-gate'].status).toBe('waiting_for_gate');
    expect(current.budget.usage).toMatchObject({
      modelCalls: 7,
      nodeAttempts: 7,
      usageReports: 7,
      estimatedCostUsd: 7,
      inputTokens: 70,
      outputTokens: 140,
    });

    current = reduceRunEvent(current, LUNA_BUILD_COUNCIL, {
      id: 'event-gate-approved',
      type: 'gate.resolved',
      nodeId: 'review-gate',
      decision: 'approved',
      at: AT,
    });

    expect(current.nodeStates['review-gate'].gateDecision).toBe('approved');
    expect(current.nodeStates.complete.status).toBe('succeeded');
    expect(current.status).toBe('succeeded');
    expect(current.completedAt).toBe(AT);
  });

  it('does not count an empty usage object as provider coverage', () => {
    let run = startRun(createInitialRun(LUNA_BUILD_COUNCIL, {
      id: 'run-empty-usage', createdAt: AT,
    }));
    run = reduceRunEvent(run, LUNA_BUILD_COUNCIL, {
      id: 'event-empty-usage-started',
      type: 'node.started',
      nodeId: 'sol-conductor',
      attemptId: 'attempt-empty-usage',
      at: AT,
    });
    run = reduceRunEvent(run, LUNA_BUILD_COUNCIL, {
      id: 'event-empty-usage-succeeded',
      type: 'node.succeeded',
      nodeId: 'sol-conductor',
      attemptId: 'attempt-empty-usage',
      at: AT,
      usage: {},
    });

    expect(run.budget.usage).toMatchObject({ modelCalls: 1, usageReports: 0 });
  });

  it('makes duplicate run events idempotent without mutating the existing run', () => {
    const queued = createInitialRun(LUNA_BUILD_COUNCIL, { id: 'run-idempotent', createdAt: AT });
    const started = startRun(queued);
    const duplicate = reduceRunEvent(started, LUNA_BUILD_COUNCIL, {
      id: 'event-run-started',
      type: 'run.started',
      at: AT,
    });

    expect(queued.status).toBe('queued');
    expect(queued.events).toHaveLength(0);
    expect(duplicate).toBe(started);
  });

  it('retries a failed builder once, then fails the run when its retry budget is spent', () => {
    let run = startAndSucceed(startRun(createInitialRun(LUNA_BUILD_COUNCIL, {
      id: 'run-retry',
      createdAt: AT,
    })), 'sol-conductor', 'sol-attempt-1');

    run = reduceRunEvent(run, LUNA_BUILD_COUNCIL, {
      id: 'event-luna-start-1',
      type: 'node.started',
      nodeId: 'luna-builder-1',
      attemptId: 'luna-attempt-1',
      at: AT,
    });
    run = reduceRunEvent(run, LUNA_BUILD_COUNCIL, {
      id: 'event-luna-failed-1',
      type: 'node.failed',
      nodeId: 'luna-builder-1',
      attemptId: 'luna-attempt-1',
      at: AT,
      error: 'transient failure',
    });
    expect(run.status).toBe('running');
    expect(run.nodeStates['luna-builder-1'].status).toBe('ready');

    run = reduceRunEvent(run, LUNA_BUILD_COUNCIL, {
      id: 'event-luna-start-2',
      type: 'node.started',
      nodeId: 'luna-builder-1',
      attemptId: 'luna-attempt-2',
      at: AT,
    });
    run = reduceRunEvent(run, LUNA_BUILD_COUNCIL, {
      id: 'event-luna-failed-2',
      type: 'node.failed',
      nodeId: 'luna-builder-1',
      attemptId: 'luna-attempt-2',
      at: AT,
      error: 'final failure',
    });

    expect(run.nodeStates['luna-builder-1'].status).toBe('failed');
    expect(run.nodeStates['luna-builder-2'].status).toBe('cancelled');
    expect(run.status).toBe('failed');
  });

  it('turns an attempted model call into a budget-exhausted run before dispatching it', () => {
    const tightBudget = defineWorkflowRevision({
      ...LUNA_BUILD_COUNCIL,
      id: 'tight-budget-council',
      budget: { maxModelCalls: 1, maxNodeAttempts: 1 },
    });
    let run = createInitialRun(tightBudget, { id: 'run-budget', createdAt: AT });
    run = reduceRunEvent(run, tightBudget, { id: 'start', type: 'run.started', at: AT });
    run = reduceRunEvent(run, tightBudget, {
      id: 'sol-start',
      type: 'node.started',
      nodeId: 'sol-conductor',
      attemptId: 'sol-attempt',
      at: AT,
    });
    run = reduceRunEvent(run, tightBudget, {
      id: 'sol-success',
      type: 'node.succeeded',
      nodeId: 'sol-conductor',
      attemptId: 'sol-attempt',
      at: AT,
    });
    run = reduceRunEvent(run, tightBudget, {
      id: 'luna-start',
      type: 'node.started',
      nodeId: 'luna-builder-1',
      attemptId: 'luna-attempt',
      at: AT,
    });

    expect(run.status).toBe('budget_exhausted');
    expect(run.nodeStates['luna-builder-1'].status).toBe('budget_exhausted');
    expect(run.budget.usage).toMatchObject({ modelCalls: 1, nodeAttempts: 1 });
  });

  it('creates a valid custom council with two or more builder lanes', () => {
    const custom = createLunaBuildCouncilDefinition({ id: 'two-lane-council', builderCount: 2 });
    expect(validateWorkflowRevision(custom).valid).toBe(true);
    expect(custom.nodes.filter((node) => node.kind === 'agent' && node.profileId === 'luna-max-builder')).toHaveLength(2);
    expect(() => createLunaBuildCouncilDefinition({ builderCount: 1 })).toThrow(/between two and twenty/i);
    expect(() => createLunaBuildCouncilDefinition({ builderCount: 21 })).toThrow(/between two and twenty/i);
  });
});
