import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowProfile,
  WorkflowRevision,
} from './domain.js';
import { agentCapForProfile, agentCapKey } from './agentCaps.js';
import { validateWorkflowInputShape } from './inputShape.js';
import { isSafeLocalIdentifier } from '../utils/localIdentifier.js';

export type WorkflowValidationCode =
  | 'invalid-workflow-id'
  | 'invalid-revision'
  | 'invalid-workflow-name'
  | 'invalid-metadata'
  | 'duplicate-profile-id'
  | 'invalid-profile'
  | 'duplicate-node-id'
  | 'invalid-node'
  | 'invalid-edge'
  | 'unknown-profile'
  | 'unknown-edge-source'
  | 'unknown-edge-target'
  | 'duplicate-edge'
  | 'self-edge'
  | 'missing-root'
  | 'multiple-roots'
  | 'root-cannot-end'
  | 'missing-end'
  | 'multiple-ends'
  | 'end-has-outgoing-edge'
  | 'node-has-no-outgoing-edge'
  | 'fanout-needs-branches'
  | 'join-needs-inputs'
  | 'gate-needs-one-output'
  | 'cycle-detected'
  | 'unreachable-node'
  | 'node-cannot-reach-end'
  | 'invalid-budget'
  | 'agent-cap-exceeded';

export interface WorkflowValidationIssue {
  readonly code: WorkflowValidationCode;
  readonly message: string;
  readonly nodeId?: string;
  readonly edge?: WorkflowEdge;
}

export interface WorkflowValidationResult {
  readonly valid: boolean;
  readonly issues: readonly WorkflowValidationIssue[];
}

export interface WorkflowTopology {
  readonly nodesById: ReadonlyMap<string, WorkflowNode>;
  readonly profilesById: ReadonlyMap<string, WorkflowProfile>;
  readonly incoming: ReadonlyMap<string, readonly string[]>;
  readonly outgoing: ReadonlyMap<string, readonly string[]>;
  readonly roots: readonly string[];
  readonly ends: readonly string[];
}

function addIssue(
  issues: WorkflowValidationIssue[],
  code: WorkflowValidationCode,
  message: string,
  nodeId?: string,
  edge?: WorkflowEdge,
): void {
  issues.push({ code, message, ...(nodeId ? { nodeId } : {}), ...(edge ? { edge } : {}) });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nodeIdsReachableFrom(
  start: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

function hasCycle(
  nodeIds: readonly string[],
  outgoing: ReadonlyMap<string, readonly string[]>,
): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return nodeIds.some((id) => visit(id));
}

export function buildWorkflowTopology(revision: WorkflowRevision): WorkflowTopology {
  const nodesById = new Map<string, WorkflowNode>();
  const profilesById = new Map<string, WorkflowProfile>();
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();

  for (const profile of revision.profiles) {
    profilesById.set(profile.id, profile);
  }
  for (const node of revision.nodes) {
    nodesById.set(node.id, node);
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of revision.edges) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;
    outgoing.get(edge.from)!.push(edge.to);
    incoming.get(edge.to)!.push(edge.from);
  }

  const roots = revision.nodes
    .filter((node) => (incoming.get(node.id) ?? []).length === 0)
    .map((node) => node.id);
  const ends = revision.nodes
    .filter((node) => node.kind === 'end')
    .map((node) => node.id);

  return { nodesById, profilesById, incoming, outgoing, roots, ends };
}

/**
 * Validate the durable graph shape. This intentionally checks graph semantics,
 * not prompt quality or provider availability; those belong to adapters.
 */
export function validateWorkflowRevision(revision: unknown): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = [...validateWorkflowInputShape(revision)];
  const definition = isObject(revision) ? revision : undefined;

  if (!isNonEmptyString(definition?.id)) {
    addIssue(issues, 'invalid-workflow-id', 'Workflow id must be a non-empty string.');
  }
  if (!isPositiveInteger(definition?.revision)) {
    addIssue(issues, 'invalid-revision', 'Workflow revision must be a positive integer.');
  }
  if (!isNonEmptyString(definition?.name)) {
    addIssue(issues, 'invalid-workflow-name', 'Workflow name must be a non-empty string.');
  }

  const rawProfiles = definition?.profiles;
  if (!Array.isArray(rawProfiles)) {
    addIssue(issues, 'invalid-profile', 'Workflow profiles must be an array.');
  }
  const profiles: WorkflowProfile[] = [];
  const profileIds = new Set<string>();
  for (const rawProfile of Array.isArray(rawProfiles) ? rawProfiles : []) {
    if (!isObject(rawProfile)) {
      addIssue(issues, 'invalid-profile', 'Every profile must be an object.');
      continue;
    }
    const profile = rawProfile as unknown as WorkflowProfile;
    const validProfile = isNonEmptyString(profile.id)
      && isNonEmptyString(profile.provider)
      && isNonEmptyString(profile.model);
    if (!validProfile) {
      addIssue(
        issues,
        'invalid-profile',
        `Profile ${JSON.stringify(profile.id)} needs id, provider, and model.`,
      );
    }
    if (isNonEmptyString(profile.id) && profileIds.has(profile.id)) {
      addIssue(issues, 'duplicate-profile-id', `Duplicate profile id: ${profile.id}.`);
    }
    if (isNonEmptyString(profile.id)) profileIds.add(profile.id);
    if (validProfile) profiles.push(profile);
  }

  const rawNodes = definition?.nodes;
  if (!Array.isArray(rawNodes)) {
    addIssue(issues, 'invalid-node', 'Workflow nodes must be an array.');
  }
  const nodes: WorkflowNode[] = [];
  const nodeIds = new Set<string>();
  for (const rawNode of Array.isArray(rawNodes) ? rawNodes : []) {
    if (!isObject(rawNode)) {
      addIssue(issues, 'invalid-node', 'Every node must be an object.');
      continue;
    }
    const node = rawNode as unknown as WorkflowNode;
    if (!isNonEmptyString(node.id) || !isNonEmptyString(node.label)) {
      addIssue(
        issues,
        'invalid-node',
        'Every node needs a non-empty id and label.',
        isNonEmptyString(node.id) ? node.id : undefined,
      );
    } else if (!isSafeLocalIdentifier(node.id)) {
      addIssue(
        issues,
        'invalid-node',
        `Node id ${JSON.stringify(node.id)} is not a safe local identifier.`,
        node.id,
      );
    }
    if (isNonEmptyString(node.id) && nodeIds.has(node.id)) {
      addIssue(issues, 'duplicate-node-id', `Duplicate node id: ${node.id}.`, node.id);
    }
    if (isNonEmptyString(node.id)) {
      nodeIds.add(node.id);
      nodes.push(node);
    }

    if (node.kind === 'agent') {
      if (!isNonEmptyString(node.prompt)) {
        addIssue(issues, 'invalid-node', 'Agent nodes need a non-empty prompt.', node.id);
      }
      if (!profileIds.has(node.profileId)) {
        addIssue(issues, 'unknown-profile', `Agent node ${node.id} references unknown profile ${node.profileId}.`, node.id);
      }
      if (node.maxAttempts !== undefined && !isPositiveInteger(node.maxAttempts)) {
        addIssue(issues, 'invalid-node', 'Agent maxAttempts must be a positive integer.', node.id);
      }
    } else if (node.kind === 'join' && node.strategy !== 'all') {
      addIssue(issues, 'invalid-node', 'Join nodes currently support only strategy "all".', node.id);
    } else if (node.kind === 'gate' && node.gate !== 'manual' && node.gate !== 'policy') {
      addIssue(issues, 'invalid-node', 'Gate nodes need a manual or policy gate.', node.id);
    } else if (!['agent', 'fanout', 'join', 'gate', 'end'].includes((node as { kind?: string }).kind ?? '')) {
      addIssue(issues, 'invalid-node', `Unsupported node kind ${(node as { kind?: string }).kind ?? 'unknown'}.`, node.id);
    }
  }

  const rawEdges = definition?.edges;
  if (!Array.isArray(rawEdges)) {
    addIssue(issues, 'invalid-edge', 'Workflow edges must be an array.');
  }
  const edges: WorkflowEdge[] = [];
  for (const rawEdge of Array.isArray(rawEdges) ? rawEdges : []) {
    if (!isObject(rawEdge)) {
      addIssue(issues, 'invalid-edge', 'Every edge must be an object.');
      continue;
    }
    const edge = rawEdge as unknown as WorkflowEdge;
    if (!isNonEmptyString(edge.from) || !isNonEmptyString(edge.to)) {
      addIssue(issues, 'invalid-edge', 'Every edge needs non-empty from and to node ids.');
      continue;
    }
    edges.push(edge);
  }

  const topology = buildWorkflowTopology({
    id: isNonEmptyString(definition?.id) ? definition.id : 'invalid-workflow',
    revision: isPositiveInteger(definition?.revision) ? definition.revision : 1,
    name: isNonEmptyString(definition?.name) ? definition.name : 'Invalid workflow',
    profiles,
    nodes,
    edges,
  });
  const assignedAgents = new Map<string, { profile: WorkflowProfile; count: number }>();
  for (const node of nodes) {
    if (node.kind !== 'agent') continue;
    const profile = topology.profilesById.get(node.profileId);
    if (!profile) continue;
    const key = agentCapKey(profile);
    const current = assignedAgents.get(key);
    assignedAgents.set(key, { profile, count: (current?.count ?? 0) + 1 });
  }
  for (const { profile, count } of assignedAgents.values()) {
    const cap = agentCapForProfile(profile);
    if (count > cap) {
      addIssue(
        issues,
        'agent-cap-exceeded',
        `Workflow assigns ${count} agents to model ${profile.model}; the preflight cap is ${cap}.`,
      );
    }
  }
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (!topology.nodesById.has(edge.from)) {
      addIssue(issues, 'unknown-edge-source', `Unknown edge source: ${edge.from}.`, undefined, edge);
    }
    if (!topology.nodesById.has(edge.to)) {
      addIssue(issues, 'unknown-edge-target', `Unknown edge target: ${edge.to}.`, undefined, edge);
    }
    if (edge.from === edge.to) {
      addIssue(issues, 'self-edge', `Self edge is not allowed: ${edge.from}.`, edge.from, edge);
    }
    const key = `${edge.from}\u0000${edge.to}`;
    if (edgeKeys.has(key)) {
      addIssue(issues, 'duplicate-edge', `Duplicate edge ${edge.from} -> ${edge.to}.`, undefined, edge);
    }
    edgeKeys.add(key);
  }

  if (topology.roots.length === 0) {
    addIssue(issues, 'missing-root', 'Workflow needs exactly one root node.');
  } else if (topology.roots.length > 1) {
    addIssue(issues, 'multiple-roots', `Workflow has ${topology.roots.length} roots; use a fanout after one root instead.`);
  } else if (topology.nodesById.get(topology.roots[0])?.kind === 'end') {
    addIssue(issues, 'root-cannot-end', 'The root node cannot also be an end node.', topology.roots[0]);
  }

  if (topology.ends.length === 0) {
    addIssue(issues, 'missing-end', 'Workflow needs one end node.');
  } else if (topology.ends.length > 1) {
    addIssue(issues, 'multiple-ends', 'Workflow needs one end node so terminal state is unambiguous.');
  }

  for (const node of nodes) {
    const inbound = topology.incoming.get(node.id) ?? [];
    const outbound = topology.outgoing.get(node.id) ?? [];
    if (node.kind === 'end') {
      if (outbound.length > 0) {
        addIssue(issues, 'end-has-outgoing-edge', 'End nodes cannot have outgoing edges.', node.id);
      }
      continue;
    }
    if (outbound.length === 0) {
      addIssue(issues, 'node-has-no-outgoing-edge', 'Non-end nodes need an outgoing edge.', node.id);
    }
    if (node.kind === 'fanout' && outbound.length < 2) {
      addIssue(issues, 'fanout-needs-branches', 'Fanout nodes need at least two outgoing branches.', node.id);
    }
    if (node.kind === 'join' && inbound.length < 2) {
      addIssue(issues, 'join-needs-inputs', 'Join nodes need at least two incoming branches.', node.id);
    }
    if (node.kind === 'gate' && outbound.length !== 1) {
      addIssue(issues, 'gate-needs-one-output', 'Gate nodes need exactly one outgoing edge.', node.id);
    }
  }

  const nodeIdList = nodes.map((node) => node.id);
  if (hasCycle(nodeIdList, topology.outgoing)) {
    addIssue(issues, 'cycle-detected', 'Workflow graphs must be acyclic.');
  }
  if (topology.roots.length === 1) {
    const reachable = nodeIdsReachableFrom(topology.roots, topology.outgoing);
    for (const nodeId of nodeIdList) {
      if (!reachable.has(nodeId)) {
        addIssue(issues, 'unreachable-node', `Node ${nodeId} cannot be reached from the root.`, nodeId);
      }
    }
  }
  if (topology.ends.length === 1) {
    const reachesEnd = nodeIdsReachableFrom(topology.ends, topology.incoming);
    for (const nodeId of nodeIdList) {
      if (!reachesEnd.has(nodeId)) {
        addIssue(issues, 'node-cannot-reach-end', `Node ${nodeId} cannot reach the end node.`, nodeId);
      }
    }
  }

  const budget = definition?.budget;
  if (budget !== undefined && !isObject(budget)) {
    addIssue(issues, 'invalid-budget', 'Workflow budget must be an object.');
  } else if (budget) {
    for (const [key, value] of Object.entries(budget)) {
      if (!isNonNegativeFinite(value)) {
        addIssue(issues, 'invalid-budget', `Budget ${key} must be a non-negative finite number.`);
      }
    }
  }

  return { valid: issues.length === 0, issues };
}
