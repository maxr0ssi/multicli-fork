import { createHash } from 'node:crypto';

import type { HarnessCheckStatus, HarnessOutcome } from '../harness/types.js';

export interface WorkflowGateApprovalArtifactInput {
  readonly id: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly nodeAttemptId?: string;
}

export interface WorkflowGateHarnessCheckInput {
  readonly ruleId: string;
  readonly label: string;
  readonly status: HarnessCheckStatus;
  readonly durationMs: number;
}

/** One completed harness event. The greatest durable sequence is reviewed. */
export interface WorkflowGateHarnessEvidenceInput {
  readonly sequence: number;
  readonly invocationId: string;
  readonly outcome: HarnessOutcome;
  readonly checks: readonly WorkflowGateHarnessCheckInput[];
  readonly findingsCount: number;
}

export interface BuildWorkflowGateApprovalPacketInput {
  readonly workflowRevisionId: string;
  readonly workflowId: string;
  readonly workflowContentHash: string;
  readonly runId: string;
  readonly gateId: string;
  readonly gatePrompt: string;
  readonly artifacts: readonly WorkflowGateApprovalArtifactInput[];
  readonly harnessEvidence?: readonly WorkflowGateHarnessEvidenceInput[];
}

export interface WorkflowGateApprovalArtifact {
  readonly id: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly nodeAttemptId?: string;
}

export interface WorkflowGateHarnessCheck {
  readonly ruleId: string;
  readonly label: string;
  readonly status: HarnessCheckStatus;
  readonly durationMs: number;
}

export interface WorkflowGateHarnessEvidence {
  readonly invocationId: string;
  readonly outcome: HarnessOutcome;
  readonly checks: readonly WorkflowGateHarnessCheck[];
  readonly findingsCount: number;
}

/**
 * Immutable evidence reviewed by a workflow-completion decision.
 *
 * `kind` and `nodeId` intentionally preserve the existing gate-resolution
 * payload contract. Paths, artifact bodies, prompts from other nodes, and
 * provider response text are never copied into this packet.
 */
export interface WorkflowGateApprovalPacket {
  readonly version: 1;
  readonly kind: 'workflow-gate';
  readonly workflowRevisionId: string;
  readonly workflowId: string;
  readonly workflowContentHash: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly prompt: string;
  readonly artifacts: readonly WorkflowGateApprovalArtifact[];
  readonly harness?: WorkflowGateHarnessEvidence;
}

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareArtifacts(
  left: WorkflowGateApprovalArtifact,
  right: WorkflowGateApprovalArtifact,
): number {
  return compareText(left.id, right.id)
    || compareText(left.contentHash, right.contentHash)
    || compareText(left.mediaType, right.mediaType)
    || compareText(left.nodeAttemptId ?? '', right.nodeAttemptId ?? '');
}

function compareChecks(
  left: WorkflowGateHarnessCheck,
  right: WorkflowGateHarnessCheck,
): number {
  return compareText(left.ruleId, right.ruleId)
    || compareText(left.label, right.label)
    || compareText(left.status, right.status)
    || left.durationMs - right.durationMs;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareText(left, right));
  return `{${entries.map(([key, child]) => (
    `${JSON.stringify(key)}:${canonicalJson(child)}`
  )).join(',')}}`;
}

function normalizeArtifacts(
  artifacts: readonly WorkflowGateApprovalArtifactInput[],
): WorkflowGateApprovalArtifact[] {
  const normalized = artifacts.map(artifact => ({
    id: requireText(artifact.id, 'Artifact id'),
    contentHash: requireText(artifact.contentHash, 'Artifact content hash'),
    mediaType: requireText(artifact.mediaType, 'Artifact media type'),
    ...(artifact.nodeAttemptId
      ? { nodeAttemptId: requireText(artifact.nodeAttemptId, 'Artifact node attempt id') }
      : {}),
  }));
  const ids = new Set<string>();
  for (const artifact of normalized) {
    if (ids.has(artifact.id)) throw new Error(`Duplicate reviewed artifact id: ${artifact.id}`);
    ids.add(artifact.id);
  }
  return normalized.sort(compareArtifacts);
}

function normalizeHarness(
  evidence: WorkflowGateHarnessEvidenceInput,
): WorkflowGateHarnessEvidence {
  requireCount(evidence.sequence, 'Harness event sequence');
  const checks = evidence.checks.map(check => ({
    ruleId: requireText(check.ruleId, 'Harness check rule id'),
    label: requireText(check.label, 'Harness check label'),
    status: check.status,
    durationMs: requireCount(check.durationMs, 'Harness check duration'),
  })).sort(compareChecks);
  return {
    invocationId: requireText(evidence.invocationId, 'Harness invocation id'),
    outcome: evidence.outcome,
    checks,
    findingsCount: requireCount(evidence.findingsCount, 'Harness findings count'),
  };
}

function latestHarnessEvidence(
  evidence: readonly WorkflowGateHarnessEvidenceInput[] | undefined,
): WorkflowGateHarnessEvidenceInput | undefined {
  if (!evidence?.length) return undefined;
  const sequences = new Set<number>();
  let latest: WorkflowGateHarnessEvidenceInput | undefined;
  for (const candidate of evidence) {
    const sequence = requireCount(candidate.sequence, 'Harness event sequence');
    if (sequences.has(sequence)) {
      throw new Error(`Duplicate harness event sequence: ${sequence}`);
    }
    sequences.add(sequence);
    if (!latest || sequence > latest.sequence) latest = candidate;
  }
  return latest;
}

/** Build a canonical, deeply frozen review packet for one workflow gate. */
export function buildWorkflowGateApprovalPacket(
  input: BuildWorkflowGateApprovalPacketInput,
): WorkflowGateApprovalPacket {
  const latestHarness = latestHarnessEvidence(input.harnessEvidence);
  const packet: WorkflowGateApprovalPacket = {
    version: 1,
    kind: 'workflow-gate',
    workflowRevisionId: requireText(input.workflowRevisionId, 'Workflow revision id'),
    workflowId: requireText(input.workflowId, 'Workflow id'),
    workflowContentHash: requireText(input.workflowContentHash, 'Workflow content hash'),
    runId: requireText(input.runId, 'Run id'),
    nodeId: requireText(input.gateId, 'Gate id'),
    prompt: requireText(input.gatePrompt, 'Gate prompt'),
    artifacts: normalizeArtifacts(input.artifacts),
    ...(latestHarness ? { harness: normalizeHarness(latestHarness) } : {}),
  };
  return freezeDeep(packet);
}

/** Hash only the packet's canonical data representation. */
export function hashWorkflowGateApprovalPacket(
  packet: WorkflowGateApprovalPacket,
): string {
  return createHash('sha256').update(canonicalJson(packet)).digest('hex');
}
