import type { WorkflowProfile } from './domain.js';

export const DEFAULT_WORKFLOW_CONCURRENCY = 5;
export const MAX_WORKFLOW_CONCURRENCY = 20;

export const WORKFLOW_AGENT_CAPS = Object.freeze({
  default: 5,
  luna: 20,
  opus: 5,
  sol: 3,
  fable: 0,
} as const);

export type CappedAgentFamily = keyof Omit<typeof WORKFLOW_AGENT_CAPS, 'default'>;

function modelSegments(model: string): Set<string> {
  return new Set(model.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

export function cappedAgentFamily(model: string): CappedAgentFamily | undefined {
  const segments = modelSegments(model);
  if (segments.has('luna')) return 'luna';
  if (segments.has('opus')) return 'opus';
  if (segments.has('sol')) return 'sol';
  if (segments.has('fable')) return 'fable';
  return undefined;
}

export function agentCapForProfile(profile: WorkflowProfile): number {
  const family = cappedAgentFamily(profile.model);
  return family ? WORKFLOW_AGENT_CAPS[family] : WORKFLOW_AGENT_CAPS.default;
}

export function agentCapKey(profile: WorkflowProfile): string {
  return cappedAgentFamily(profile.model) ?? `model:${profile.model.toLowerCase()}`;
}

export function assertWorkflowConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_WORKFLOW_CONCURRENCY) {
    throw new RangeError(
      `Workflow concurrency must be between one and ${MAX_WORKFLOW_CONCURRENCY}.`,
    );
  }
  return value;
}
