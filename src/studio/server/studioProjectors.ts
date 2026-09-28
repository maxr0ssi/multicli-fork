import type {
  ApprovalRecord,
  ArtifactRecord,
  DurableNodeAttemptRecord,
  DurableRunEvent,
  DurableRunRecord,
  GoalSessionArtifactRecord,
  GoalSessionRecord,
  WorkflowRevisionRecord,
} from '../../persistence/runLedger.js';
import type {
  NodeStatus,
  RunRecord,
  WorkflowRevision,
} from '../../workflows/domain.js';
import {
  hashWorkflowGateApprovalPacket,
  type WorkflowGateApprovalPacket,
} from '../../workflows/approvalPacket.js';
import { projectGoalSessionUsage } from '../../workflows/goalSessionUsage.js';
import type {
  StudioApproval,
  StudioArtifactSummary,
  StudioGoalSessionSummary,
  StudioHarnessEvidence,
  StudioNodeExecution,
  StudioRunSummary,
  StudioWorkflowRevision,
  StudioWorkflowSummary,
} from '../contracts/studio.js';
import type { StudioArtifactReader } from './artifactReader.js';

const NODE_STATUSES: readonly NodeStatus[] = [
  'pending', 'ready', 'running', 'waiting_for_gate', 'succeeded',
  'failed', 'cancelled', 'budget_exhausted',
];

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function asWorkflowRevision(record: WorkflowRevisionRecord): WorkflowRevision {
  return record.definition as WorkflowRevision;
}

export function projectWorkflow(record: WorkflowRevisionRecord): StudioWorkflowRevision {
  const definition = asWorkflowRevision(record);
  const profiles = Object.fromEntries(definition.profiles.map(profile => [profile.id, {
    id: profile.id,
    label: profile.label,
    role: profile.role,
    provider: profile.provider,
    model: profile.model,
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    workspaceAccess: profile.workspaceAccess,
    selection: profile.selection,
    enableSubagents: profile.enableSubagents ?? false,
    ...(profile.description ? { description: profile.description } : {}),
  }]));
  return {
    recordId: record.id,
    workflowId: record.workflowId,
    logicalRevision: definition.revision,
    contentHash: record.contentHash,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    createdAt: record.createdAt,
    metadata: { ...(definition.metadata ?? {}) },
    profiles,
    nodes: definition.nodes,
    edges: definition.edges,
  };
}

export function projectWorkflowSummary(record: WorkflowRevisionRecord): StudioWorkflowSummary {
  const definition = asWorkflowRevision(record);
  const agentProfiles = definition.nodes.flatMap(node => {
    if (node.kind !== 'agent') return [];
    const profile = definition.profiles.find(candidate => candidate.id === node.profileId);
    return profile ? [profile] : [];
  });
  return {
    recordId: record.id,
    workflowId: record.workflowId,
    logicalRevision: definition.revision,
    contentHash: record.contentHash,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    createdAt: record.createdAt,
    nodeCount: definition.nodes.length,
    agentCount: definition.nodes.filter(node => node.kind === 'agent').length,
    providers: [...new Set(definition.profiles.map(profile => profile.provider))].sort(),
    models: [...new Set(definition.profiles.map(profile => profile.model))].sort(),
    workspaceAccess: [...new Set(agentProfiles.map(profile => profile.workspaceAccess))].sort(),
    writerAgentCount: agentProfiles.filter(profile => profile.workspaceAccess !== 'read-only').length,
    enableSubagents: agentProfiles.some(profile => profile.enableSubagents ?? false),
  };
}

function emptyNodeCounts(): Record<NodeStatus, number> {
  return Object.fromEntries(NODE_STATUSES.map(status => [status, 0])) as Record<NodeStatus, number>;
}

export function projectRunSummary(
  run: DurableRunRecord,
  workflow: WorkflowRevisionRecord,
  semantic: RunRecord,
): StudioRunSummary {
  const counts = emptyNodeCounts();
  for (const state of Object.values(semantic.nodeStates)) {
    counts[terminalNodeStatus(run, state.status)] += 1;
  }
  const objective = string(object(run.input)?.objective);
  return {
    id: run.id,
    workflowRevisionId: run.workflowRevisionId,
    workflowId: workflow.workflowId,
    workflowName: asWorkflowRevision(workflow).name,
    status: run.status,
    ...(objective ? { objective } : {}),
    ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    lastSequence: run.lastSequence,
    nodeCounts: counts,
  };
}

function terminalNodeStatus(run: DurableRunRecord, semanticStatus: NodeStatus): NodeStatus {
  if (!['completed', 'failed', 'cancelled'].includes(run.status)) return semanticStatus;
  if (['succeeded', 'failed', 'cancelled', 'budget_exhausted'].includes(semanticStatus)) {
    return semanticStatus;
  }
  return run.status === 'completed' ? semanticStatus : 'cancelled';
}

export function projectNodeExecutions(input: {
  run: DurableRunRecord;
  semantic: RunRecord;
  attempts: readonly DurableNodeAttemptRecord[];
  artifacts: readonly ArtifactRecord[];
  approvals: readonly ApprovalRecord[];
  serverTime: string;
}): { nodes: Record<string, StudioNodeExecution>; issues: string[] } {
  const issues: string[] = [];
  const attemptsByNode = new Map<string, DurableNodeAttemptRecord[]>();
  for (const attempt of input.attempts) {
    const bucket = attemptsByNode.get(attempt.nodeId) ?? [];
    bucket.push(attempt);
    attemptsByNode.set(attempt.nodeId, bucket);
    if (!input.semantic.nodeStates[attempt.nodeId]) {
      issues.push(`Attempt ${attempt.id} references unknown node ${attempt.nodeId}.`);
    }
  }
  const artifactsByAttempt = new Map<string, ArtifactRecord[]>();
  for (const artifact of input.artifacts) {
    if (!artifact.nodeAttemptId) continue;
    const bucket = artifactsByAttempt.get(artifact.nodeAttemptId) ?? [];
    bucket.push(artifact);
    artifactsByAttempt.set(artifact.nodeAttemptId, bucket);
  }
  const now = Date.parse(input.serverTime);
  const nodes: Record<string, StudioNodeExecution> = {};

  for (const [nodeId, semantic] of Object.entries(input.semantic.nodeStates)) {
    const durable = [...(attemptsByNode.get(nodeId) ?? [])]
      .sort((left, right) => left.attemptNumber - right.attemptNumber);
    const running = durable.find(attempt => attempt.status === 'running');
    if (semantic.activeAttemptId && running?.id !== semantic.activeAttemptId) {
      issues.push(`Node ${nodeId} reducer and lease state disagree about its active attempt.`);
    }
    const attempts = durable.map(attempt => {
      const expiresAt = attempt.leaseExpiresAt ? Date.parse(attempt.leaseExpiresAt) : Number.NaN;
      const semanticUsage = input.semantic.nodeStates[nodeId]?.attempts
        .find(candidate => candidate.id === attempt.id)?.usage;
      const hasUsage = semanticUsage && Object.values(semanticUsage)
        .some(value => value !== undefined);
      return {
        id: attempt.id,
        number: attempt.attemptNumber,
        status: attempt.status,
        ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
        ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
        ...(attempt.outputArtifactId ? { outputArtifactId: attempt.outputArtifactId } : {}),
        ...(attempt.error ? { error: attempt.error } : {}),
        ...(hasUsage ? { usage: semanticUsage } : {}),
        ...(attempt.status === 'running' && attempt.leaseExpiresAt
          ? {
            lease: {
              state: Number.isFinite(expiresAt) && expiresAt > now ? 'active' as const : 'overdue' as const,
              lastRenewedAt: attempt.updatedAt,
              expiresAt: attempt.leaseExpiresAt,
            },
          }
          : {}),
      };
    });
    const queued = durable.some(attempt => attempt.status === 'queued');
    const artifactIds = durable.flatMap(attempt => (
      artifactsByAttempt.get(attempt.id)?.map(artifact => artifact.id) ?? []
    ));
    const approvalIds = input.approvals.flatMap(approval => {
      const payload = object(approval.payload);
      return payload?.nodeId === nodeId || durable.some(attempt => attempt.id === approval.nodeAttemptId)
        ? [approval.id]
        : [];
    });
    nodes[nodeId] = {
      nodeId,
      status: semantic.status === 'ready' && queued
        ? 'queued'
        : terminalNodeStatus(input.run, semantic.status),
      ...(semantic.activeAttemptId ? { activeAttemptId: semantic.activeAttemptId } : {}),
      ...(semantic.gateDecision ? { gateDecision: semantic.gateDecision } : {}),
      attempts,
      artifactIds,
      approvalIds,
    };
  }
  return { nodes, issues };
}

export function projectArtifactSummaries(
  artifacts: readonly ArtifactRecord[],
  reader?: StudioArtifactReader,
): StudioArtifactSummary[] {
  return artifacts.map(artifact => reader
    ? reader.summarize(artifact.runId, artifact.id)
    : {
      id: artifact.id,
      runId: artifact.runId,
      ...(artifact.nodeAttemptId ? { nodeAttemptId: artifact.nodeAttemptId } : {}),
      name: artifact.name,
      mediaType: artifact.mediaType,
      contentHash: artifact.contentHash,
      createdAt: artifact.createdAt,
      preview: { allowed: false, reason: 'Artifact preview is not configured' },
    });
}

export function projectHarness(events: readonly DurableRunEvent[]): StudioHarnessEvidence[] {
  return events.flatMap(event => {
    if (event.type !== 'harness.completed') return [];
    const payload = object(event.payload) ?? {};
    return [{
      ...(string(payload.gateId) ? { gateId: string(payload.gateId) } : {}),
      ...(string(payload.invocationId) ? { invocationId: string(payload.invocationId) } : {}),
      outcome: string(payload.outcome) ?? 'unknown',
      ...(typeof payload.findingCount === 'number' ? { findingCount: payload.findingCount } : {}),
      checks: Array.isArray(payload.checks) ? payload.checks : [],
      completedAt: event.timestamp,
      sequence: event.sequence,
    }];
  });
}

export function projectGoalSession(
  session: GoalSessionRecord,
  artifacts: readonly GoalSessionArtifactRecord[],
  serverTime: string,
  commandsEnabled: boolean,
): StudioGoalSessionSummary {
  const expiry = session.turnLeaseExpiresAt ? Date.parse(session.turnLeaseExpiresAt) : Number.NaN;
  return {
    id: session.id,
    ...(session.runId ? { runId: session.runId } : {}),
    ...(session.workflowRevisionId ? { workflowRevisionId: session.workflowRevisionId } : {}),
    profileId: session.profileId,
    provider: session.provider,
    model: session.model,
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
    workspaceAccess: session.workspaceAccess,
    enableSubagents: session.enableSubagents,
    status: session.status,
    turnState: session.turnState,
    turnCount: session.turnCount,
    updatedAt: session.updatedAt,
    providerUsage: projectGoalSessionUsage(artifacts),
    ...(session.turnState === 'running' && session.turnLeaseExpiresAt
      ? {
        turnLease: {
          state: Number.isFinite(expiry) && expiry > Date.parse(serverTime)
            ? 'active' as const
            : 'overdue' as const,
          expiresAt: session.turnLeaseExpiresAt,
        },
      }
      : {}),
    allowedActions: {
      sendInstruction: commandsEnabled && session.status === 'active' && session.turnState === 'idle'
        ? { allowed: true }
        : {
          allowed: false,
          reason: commandsEnabled
            ? 'Instructions can be sent only to an active, idle goal session'
            : 'Goal-session commands are not configured for this Studio server',
        },
      close: commandsEnabled && session.status !== 'closed' && session.turnState === 'idle'
        ? { allowed: true }
        : {
          allowed: false,
          reason: commandsEnabled
            ? 'A closed session or a session with a turn in flight cannot be closed'
            : 'Goal-session commands are not configured for this Studio server',
        },
    },
  };
}

export function projectApproval(input: {
  approval: ApprovalRecord;
  runMutable: boolean;
  serverTime: string;
}): StudioApproval {
  const payload = object(input.approval.payload);
  const nodeId = string(payload?.nodeId);
  const prompt = string(payload?.prompt);
  const expired = input.approval.expiresAt
    ? Date.parse(input.approval.expiresAt) <= Date.parse(input.serverTime)
    : false;
  const packetArtifacts = Array.isArray(payload?.artifacts)
    ? payload.artifacts.flatMap(value => {
      const artifact = object(value);
      const id = string(artifact?.id);
      return id ? [id] : [];
    })
    : [];
  const packetHarness = object(payload?.harness);
  const packetHashMatches = payload?.version === 1 && payload.kind === 'workflow-gate'
    ? hashWorkflowGateApprovalPacket(input.approval.payload as WorkflowGateApprovalPacket)
      === input.approval.actionHash
    : false;
  const context = packetHashMatches && nodeId && prompt
    ? {
      kind: 'workflow-gate' as const,
      nodeId,
      prompt,
      artifactIds: packetArtifacts,
      harnessInvocationIds: string(packetHarness?.invocationId)
        ? [string(packetHarness?.invocationId)!]
        : [],
    }
    : { kind: 'unknown' as const, payload: input.approval.payload };
  const evidenceAvailable = context.kind !== 'unknown';
  const resolvable = input.approval.status === 'pending'
    && input.runMutable
    && !expired
    && evidenceAvailable;
  return {
    id: input.approval.id,
    runId: input.approval.runId,
    ...(input.approval.nodeAttemptId ? { nodeAttemptId: input.approval.nodeAttemptId } : {}),
    actionHash: input.approval.actionHash,
    risk: input.approval.risk,
    status: input.approval.status,
    requestedAt: input.approval.requestedAt,
    ...(input.approval.resolvedAt ? { resolvedAt: input.approval.resolvedAt } : {}),
    ...(input.approval.expiresAt ? { expiresAt: input.approval.expiresAt } : {}),
    ...(input.approval.decisionBy ? { decisionBy: input.approval.decisionBy } : {}),
    context,
    resolve: resolvable
      ? { allowed: true }
      : {
        allowed: false,
        reason: expired
          ? 'Approval has expired'
          : !evidenceAvailable
            ? 'Approval evidence is unavailable or does not match its action hash'
            : 'Approval is not pending on a mutable run',
      },
  };
}
