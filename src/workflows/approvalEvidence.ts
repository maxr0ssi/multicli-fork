import type { RunSnapshot } from '../controlPlane/controlPlane.js';
import type { HarnessCheckStatus, HarnessOutcome } from '../harness/types.js';
import {
  buildWorkflowGateApprovalPacket,
  hashWorkflowGateApprovalPacket,
  type WorkflowGateHarnessEvidenceInput,
} from './approvalPacket.js';
import type { GateNode } from './domain.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function harnessEvidence(
  snapshot: RunSnapshot,
  gateId: string,
): WorkflowGateHarnessEvidenceInput[] {
  return snapshot.events.flatMap(event => {
    const payload = record(event.payload);
    if (
      event.type !== 'harness.completed'
      || payload?.gateId !== gateId
      || typeof payload.invocationId !== 'string'
      || typeof payload.outcome !== 'string'
      || !Array.isArray(payload.checks)
      || typeof payload.findingCount !== 'number'
    ) return [];

    const checks = payload.checks.flatMap(value => {
      const check = record(value);
      return typeof check?.ruleId === 'string'
        && typeof check.label === 'string'
        && typeof check.status === 'string'
        && typeof check.durationMs === 'number'
        ? [{
          ruleId: check.ruleId,
          label: check.label,
          status: check.status as HarnessCheckStatus,
          durationMs: check.durationMs,
        }]
        : [];
    });
    return [{
      sequence: event.sequence,
      invocationId: payload.invocationId,
      outcome: payload.outcome as HarnessOutcome,
      checks,
      findingsCount: payload.findingCount,
    }];
  });
}

/** Bind a gate decision to the exact immutable workflow and reviewed evidence. */
export function createWorkflowGateApproval(
  snapshot: RunSnapshot,
  gate: GateNode,
): { actionHash: string; payload: ReturnType<typeof buildWorkflowGateApprovalPacket> } {
  const packet = buildWorkflowGateApprovalPacket({
    workflowRevisionId: snapshot.workflowRevision.id,
    workflowId: snapshot.workflowRevision.workflowId,
    workflowContentHash: snapshot.workflowRevision.contentHash,
    runId: snapshot.run.id,
    gateId: gate.id,
    gatePrompt: gate.prompt,
    artifacts: snapshot.artifacts.map(artifact => ({
      id: artifact.id,
      contentHash: artifact.contentHash,
      mediaType: artifact.mediaType,
      ...(artifact.nodeAttemptId ? { nodeAttemptId: artifact.nodeAttemptId } : {}),
    })),
    harnessEvidence: harnessEvidence(snapshot, gate.id),
  });
  return { actionHash: hashWorkflowGateApprovalPacket(packet), payload: packet };
}
