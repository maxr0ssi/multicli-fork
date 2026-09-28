import type {
  AgentNode,
  WorkflowEdge,
  WorkflowProfile,
  WorkflowRevision,
} from '../../../../workflows/domain.js';
import {
  modelRequiresExplicitSelection,
  reasoningEffortsForWorkflowModel,
} from '../../../../workflows/providerPolicy.js';

function nextIdentifier(base: string, used: ReadonlySet<string>): string {
  const stem = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '') || 'agent';
  if (!used.has(stem)) return stem;
  let suffix = 2;
  while (used.has(`${stem}-${suffix}`)) suffix += 1;
  return `${stem}-${suffix}`;
}

function profileForNewAgent(
  definition: WorkflowRevision,
  source?: WorkflowProfile,
): WorkflowProfile {
  const id = nextIdentifier(
    source ? `${source.id}-copy` : 'new-profile',
    new Set(definition.profiles.map(profile => profile.id)),
  );
  return source
    ? { ...source, id, label: `${source.label} copy` }
    : {
      id,
      label: 'New profile',
      role: 'custom',
      provider: '',
      model: '',
      workspaceAccess: 'read-only',
      selection: 'explicit-only',
      enableSubagents: false,
    };
}

export interface DefinitionChange {
  readonly definition: WorkflowRevision;
  readonly selectedNodeId: string;
}

export function updateWorkflowNode(
  definition: WorkflowRevision,
  nodeId: string,
  update: (node: WorkflowRevision['nodes'][number]) => WorkflowRevision['nodes'][number],
): WorkflowRevision {
  return {
    ...definition,
    nodes: definition.nodes.map(node => node.id === nodeId ? update(node) : node),
  };
}

export function updateWorkflowProfile(
  definition: WorkflowRevision,
  profileId: string,
  update: (profile: WorkflowProfile) => WorkflowProfile,
): WorkflowRevision {
  return {
    ...definition,
    profiles: definition.profiles.map(profile => profile.id === profileId ? update(profile) : profile),
  };
}

/** Keep model-specific selection invariants atomic with an editor model change. */
export function withWorkflowProfileModel(
  profile: WorkflowProfile,
  model: string,
): WorkflowProfile {
  const next: WorkflowProfile = {
    ...profile,
    model,
    ...(modelRequiresExplicitSelection(model) ? { selection: 'explicit-only' } : {}),
  };
  if (!profile.reasoningEffort
    || (profile.provider !== 'codex' && profile.provider !== 'claude')
    || reasoningEffortsForWorkflowModel(profile.provider, model).includes(profile.reasoningEffort)) {
    return next;
  }
  const { reasoningEffort: _removed, ...withoutEffort } = next;
  return withoutEffort;
}

export function addAgentNode(
  definition: WorkflowRevision,
  sourceNodeId?: string,
): DefinitionChange {
  const sourceNode = definition.nodes.find(node => node.id === sourceNodeId);
  const sourceProfile = sourceNode?.kind === 'agent'
    ? definition.profiles.find(profile => profile.id === sourceNode.profileId)
    : definition.profiles[0];
  const profile = sourceProfile ?? profileForNewAgent(definition);
  const id = nextIdentifier('new-agent', new Set(definition.nodes.map(node => node.id)));
  const node: AgentNode = {
    id,
    kind: 'agent',
    label: 'New agent',
    profileId: profile.id,
    prompt: '',
  };
  const sourceEdges = sourceNode
    ? sourceNode.kind === 'end'
      ? definition.edges.filter(edge => edge.to === sourceNode.id)
      : definition.edges.filter(edge => edge.from === sourceNode.id)
    : [];
  const edges = !sourceNode
    ? definition.edges
    : sourceNode.kind === 'end'
      ? [
        ...definition.edges.filter(edge => edge.to !== sourceNode.id),
        ...sourceEdges.map(edge => ({ ...edge, to: id })),
        { from: id, to: sourceNode.id },
      ]
      : [
        ...definition.edges.filter(edge => edge.from !== sourceNode.id),
        { from: sourceNode.id, to: id },
        ...sourceEdges.map(edge => ({ ...edge, from: id })),
      ];
  return {
    definition: {
      ...definition,
      profiles: sourceProfile ? definition.profiles : [...definition.profiles, profile],
      nodes: [...definition.nodes, node],
      edges,
    },
    selectedNodeId: id,
  };
}

export function duplicateAgentNode(
  definition: WorkflowRevision,
  nodeId: string,
): DefinitionChange | undefined {
  const source = definition.nodes.find(node => node.id === nodeId);
  if (source?.kind !== 'agent') return undefined;
  const sourceProfile = definition.profiles.find(profile => profile.id === source.profileId);
  if (!sourceProfile) return undefined;
  const profile = profileForNewAgent(definition, sourceProfile);
  const id = nextIdentifier(`${source.id}-copy`, new Set(definition.nodes.map(node => node.id)));
  const node: AgentNode = {
    ...source,
    id,
    label: `${source.label} copy`,
    profileId: profile.id,
  };
  const incoming = definition.edges
    .filter(edge => edge.to === source.id)
    .map(edge => ({ ...edge, to: id }));
  const outgoing = definition.edges
    .filter(edge => edge.from === source.id)
    .map(edge => ({ ...edge, from: id }));
  return {
    definition: {
      ...definition,
      profiles: [...definition.profiles, profile],
      nodes: [...definition.nodes, node],
      edges: [...definition.edges, ...incoming, ...outgoing],
    },
    selectedNodeId: id,
  };
}

export function removeAgentNode(
  definition: WorkflowRevision,
  nodeId: string,
): WorkflowRevision {
  const node = definition.nodes.find(candidate => candidate.id === nodeId);
  if (node?.kind !== 'agent') return definition;
  const nodes = definition.nodes.filter(candidate => candidate.id !== nodeId);
  const incoming = definition.edges.filter(edge => edge.to === nodeId);
  const outgoing = definition.edges.filter(edge => edge.from === nodeId);
  const retainedEdges = definition.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);
  const retainedKeys = new Set(retainedEdges.map(edge => `${edge.from}\u0000${edge.to}`));
  const reconnected = incoming.flatMap(before => outgoing.flatMap(after => {
    const key = `${before.from}\u0000${after.to}`;
    if (before.from === after.to || retainedKeys.has(key)) return [];
    retainedKeys.add(key);
    return [{ from: before.from, to: after.to }];
  }));
  const profileStillUsed = nodes.some(candidate => (
    candidate.kind === 'agent' && candidate.profileId === node.profileId
  ));
  return {
    ...definition,
    nodes,
    edges: [...retainedEdges, ...reconnected],
    profiles: profileStillUsed
      ? definition.profiles
      : definition.profiles.filter(profile => profile.id !== node.profileId),
  };
}

export function makeAgentProfileUnique(
  definition: WorkflowRevision,
  nodeId: string,
): WorkflowRevision {
  const node = definition.nodes.find(candidate => candidate.id === nodeId);
  if (node?.kind !== 'agent') return definition;
  const profile = definition.profiles.find(candidate => candidate.id === node.profileId);
  if (!profile) return definition;
  const copy = profileForNewAgent(definition, profile);
  return {
    ...definition,
    profiles: [...definition.profiles, copy],
    nodes: definition.nodes.map(candidate => candidate.id === nodeId
      ? { ...candidate, profileId: copy.id }
      : candidate),
  };
}

export function setNodeDependency(
  definition: WorkflowRevision,
  nodeId: string,
  predecessorId: string,
  enabled: boolean,
): WorkflowRevision {
  if (nodeId === predecessorId) return definition;
  const matches = (edge: WorkflowEdge) => edge.from === predecessorId && edge.to === nodeId;
  const exists = definition.edges.some(matches);
  if (enabled === exists) return definition;
  return {
    ...definition,
    edges: enabled
      ? [...definition.edges, { from: predecessorId, to: nodeId }]
      : definition.edges.filter(edge => !matches(edge)),
  };
}

export function canAddNodeDependency(
  definition: WorkflowRevision,
  nodeId: string,
  predecessorId: string,
): boolean {
  if (nodeId === predecessorId) return false;
  const outgoing = new Map<string, string[]>();
  for (const edge of definition.edges) {
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const pending = [nodeId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === predecessorId) return false;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  return true;
}

export function profileUseCount(definition: WorkflowRevision, profileId: string): number {
  return definition.nodes.filter(node => (
    node.kind === 'agent' && node.profileId === profileId
  )).length;
}
