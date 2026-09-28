import { describe, expect, it } from 'vitest';

import {
  buildWorkflowGateApprovalPacket,
  hashWorkflowGateApprovalPacket,
  type BuildWorkflowGateApprovalPacketInput,
} from '../../src/workflows/approvalPacket.js';

function packetInput(): BuildWorkflowGateApprovalPacketInput {
  return {
    workflowRevisionId: 'revision-7',
    workflowId: 'claude-deep-delivery',
    workflowContentHash: 'workflow-sha256',
    runId: 'run-42',
    gateId: 'review-gate',
    gatePrompt: 'Review the implementation evidence before completion.',
    artifacts: [
      {
        id: 'artifact-b',
        contentHash: 'artifact-b-sha256',
        mediaType: 'text/markdown',
        nodeAttemptId: 'attempt-b',
      },
      {
        id: 'artifact-a',
        contentHash: 'artifact-a-sha256',
        mediaType: 'text/x-diff',
        nodeAttemptId: 'attempt-a',
      },
    ],
    harnessEvidence: [
      {
        sequence: 8,
        invocationId: 'harness-old',
        outcome: 'warn',
        findingsCount: 1,
        checks: [],
      },
      {
        sequence: 12,
        invocationId: 'harness-latest',
        outcome: 'pass',
        findingsCount: 0,
        checks: [
          { ruleId: 'repo.tests', label: 'Tests', status: 'passed', durationMs: 20 },
          { ruleId: 'repo.build', label: 'Build', status: 'passed', durationMs: 10 },
        ],
      },
    ],
  };
}

describe('workflow gate approval packet', () => {
  it('canonicalizes evidence order, selects the latest harness event, and freezes deeply', () => {
    const input = packetInput();
    const packet = buildWorkflowGateApprovalPacket(input);
    const reordered = buildWorkflowGateApprovalPacket({
      ...input,
      artifacts: [...input.artifacts].reverse(),
      harnessEvidence: [...input.harnessEvidence!].reverse().map(evidence => ({
        ...evidence,
        checks: [...evidence.checks].reverse(),
      })),
    });

    expect(packet.artifacts.map(artifact => artifact.id)).toEqual(['artifact-a', 'artifact-b']);
    expect(packet.harness?.invocationId).toBe('harness-latest');
    expect(packet.harness?.checks.map(check => check.ruleId)).toEqual(['repo.build', 'repo.tests']);
    expect(hashWorkflowGateApprovalPacket(packet)).toBe(hashWorkflowGateApprovalPacket(reordered));
    expect(Object.isFrozen(packet)).toBe(true);
    expect(Object.isFrozen(packet.artifacts)).toBe(true);
    expect(Object.isFrozen(packet.artifacts[0])).toBe(true);
    expect(Object.isFrozen(packet.harness)).toBe(true);
    expect(Object.isFrozen(packet.harness?.checks)).toBe(true);
  });

  it.each([
    ['workflow content hash', (input: BuildWorkflowGateApprovalPacketInput) => ({
      ...input, workflowContentHash: 'changed-workflow-hash',
    })],
    ['gate prompt', (input: BuildWorkflowGateApprovalPacketInput) => ({
      ...input, gatePrompt: 'Changed approval consequence.',
    })],
    ['artifact content hash', (input: BuildWorkflowGateApprovalPacketInput) => ({
      ...input,
      artifacts: input.artifacts.map((artifact, index) => index === 0
        ? { ...artifact, contentHash: 'changed-artifact-hash' }
        : artifact),
    })],
    ['harness outcome', (input: BuildWorkflowGateApprovalPacketInput) => ({
      ...input,
      harnessEvidence: input.harnessEvidence?.map(evidence => evidence.sequence === 12
        ? { ...evidence, outcome: 'warn' as const }
        : evidence),
    })],
    ['harness check duration', (input: BuildWorkflowGateApprovalPacketInput) => ({
      ...input,
      harnessEvidence: input.harnessEvidence?.map(evidence => evidence.sequence === 12
        ? {
          ...evidence,
          checks: evidence.checks.map(check => check.ruleId === 'repo.build'
            ? { ...check, durationMs: check.durationMs + 1 }
            : check),
        }
        : evidence),
    })],
    ['findings count', (input: BuildWorkflowGateApprovalPacketInput) => ({
      ...input,
      harnessEvidence: input.harnessEvidence?.map(evidence => evidence.sequence === 12
        ? { ...evidence, findingsCount: 1 }
        : evidence),
    })],
  ] as const)('changes the hash when %s changes', (_label, mutate) => {
    const input = packetInput();
    const baseline = hashWorkflowGateApprovalPacket(buildWorkflowGateApprovalPacket(input));
    const changed = hashWorkflowGateApprovalPacket(buildWorkflowGateApprovalPacket(mutate(input)));

    expect(changed).not.toBe(baseline);
  });

  it('does not copy artifact locations, metadata, or provider text into the packet', () => {
    const input = packetInput();
    const packet = buildWorkflowGateApprovalPacket({
      ...input,
      artifacts: [{
        ...input.artifacts[0],
        location: '/private/workspace/result.md',
        metadata: { providerReply: 'private model output' },
      }],
    });

    expect(JSON.stringify(packet)).not.toContain('/private/workspace');
    expect(JSON.stringify(packet)).not.toContain('private model output');
  });

  it('rejects ambiguous duplicate harness sequences', () => {
    const input = packetInput();
    expect(() => buildWorkflowGateApprovalPacket({
      ...input,
      harnessEvidence: [input.harnessEvidence![0], {
        ...input.harnessEvidence![1],
        sequence: input.harnessEvidence![0].sequence,
      }],
    })).toThrow(/duplicate harness event sequence/i);
  });
});
