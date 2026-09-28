import {
  agent,
  approval,
  defineWorkflow,
  parallel,
  profiles,
  review,
  sequence,
} from './dsl.js';
import type { WorkflowRevision } from './domain.js';

export interface ClaudeWorkflowOptions {
  readonly enableSubagents?: boolean;
}

/** A bounded, read-only Opus workflow for framing and challenging a large task. */
export function createClaudeDeepThinkWorkflow(
  options: ClaudeWorkflowOptions = {},
): WorkflowRevision {
  const opus = profiles.opus({
    id: options.enableSubagents ? 'opus-deep-think-delegating' : 'opus-deep-think',
    enableSubagents: options.enableSubagents ?? false,
  });
  return defineWorkflow({
    id: 'claude-deep-think',
    name: 'Claude deep think',
    steps: sequence(
      agent('frame', opus, 'Frame {{objective}} precisely. Identify assumptions, unknowns, risks, and success criteria.'),
      parallel('analysis', [
        agent('architecture', opus, 'Analyze {{objective}} from architecture, systems, and implementation perspectives.'),
        agent('red-team', opus, 'Challenge {{objective}}, seek failure modes, and propose safer alternatives.'),
      ]),
      agent('synthesis', opus, 'Synthesize every prior artifact into a decisive, deeply reasoned plan for {{objective}}.'),
      approval('accept-plan', 'Approve the Claude deep-thinking result and its reviewed evidence.'),
    ),
  });
}

/** An Opus-led plan/review workflow with serialized Sonnet write lanes. */
export function createClaudeDeepDeliveryWorkflow(
  options: ClaudeWorkflowOptions = {},
): WorkflowRevision {
  const opus = profiles.opus({
    id: options.enableSubagents ? 'opus-delivery-delegating' : 'opus-delivery',
    enableSubagents: options.enableSubagents ?? false,
  });
  const sonnet = profiles.sonnet({
    id: 'sonnet-delivery-builder',
    role: 'builder',
    workspaceAccess: 'workspace-write',
  });
  return defineWorkflow({
    id: 'claude-deep-delivery',
    name: 'Claude deep delivery',
    steps: sequence(
      agent('plan', opus, 'Develop a rigorous plan for {{objective}}, including acceptance criteria and risks.'),
      parallel('implementation', [
        agent('core', sonnet, 'Implement the core of {{objective}} and verify the changed behavior.'),
        agent('integration', sonnet, 'Implement the integration and usability portion of {{objective}} with tests.'),
      ]),
      review('review', {
        prompt: 'Independently review the implementation and evidence for {{objective}}.',
        reviewers: [{ profile: opus, count: 2 }],
      }),
      agent('final', opus, 'Synthesize the plan, implementation, tests, and reviews into a final recommendation.'),
      approval('ship', 'Approve the completed Claude workflow and its reviewed evidence.'),
    ),
  });
}

export const CLAUDE_DEEP_THINK = createClaudeDeepThinkWorkflow();
export const CLAUDE_DEEP_DELIVERY = createClaudeDeepDeliveryWorkflow();
