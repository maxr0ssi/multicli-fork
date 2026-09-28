import type { WorkflowEdge, WorkflowNode } from '../../../../workflows/domain.js';

export interface PositionedNode {
  readonly node: WorkflowNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly layer: number;
}

export interface DagLayout {
  readonly nodes: readonly PositionedNode[];
  readonly width: number;
  readonly height: number;
  readonly cyclicNodeIds: readonly string[];
}

const NODE_WIDTH = 224;
const NODE_HEIGHT = 84;
const COLUMN_GAP = 84;
const ROW_GAP = 28;
const PADDING = 24;

export function layoutDag(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): DagLayout {
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const nodeIds = new Set(order.keys());
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]));
  const layer = new Map(nodes.map(node => [node.id, 0]));

  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    outgoing.get(edge.from)!.push(edge.to);
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
  }
  for (const targets of outgoing.values()) {
    targets.sort((left, right) => order.get(left)! - order.get(right)!);
  }

  const ready = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  const visited = new Set<string>();
  while (ready.length > 0) {
    ready.sort((left, right) => order.get(left)! - order.get(right)!);
    const id = ready.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const target of outgoing.get(id) ?? []) {
      layer.set(target, Math.max(layer.get(target)!, layer.get(id)! + 1));
      const remaining = incoming.get(target)! - 1;
      incoming.set(target, remaining);
      if (remaining === 0) ready.push(target);
    }
  }

  const cyclicNodeIds = nodes.filter(node => !visited.has(node.id)).map(node => node.id);
  const lastAcyclicLayer = Math.max(0, ...layer.values());
  cyclicNodeIds.forEach((id, index) => layer.set(id, lastAcyclicLayer + 1 + index));

  const byLayer = new Map<number, WorkflowNode[]>();
  for (const node of nodes) {
    const nodeLayer = layer.get(node.id)!;
    const values = byLayer.get(nodeLayer) ?? [];
    values.push(node);
    byLayer.set(nodeLayer, values);
  }

  const positioned = nodes.map(node => {
    const nodeLayer = layer.get(node.id)!;
    const row = byLayer.get(nodeLayer)!.findIndex(candidate => candidate.id === node.id);
    return {
      node,
      layer: nodeLayer,
      x: PADDING + nodeLayer * (NODE_WIDTH + COLUMN_GAP),
      y: PADDING + row * (NODE_HEIGHT + ROW_GAP),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const maxLayer = Math.max(0, ...positioned.map(node => node.layer));
  const maxRows = Math.max(1, ...[...byLayer.values()].map(values => values.length));

  return {
    nodes: positioned,
    width: PADDING * 2 + NODE_WIDTH + maxLayer * (NODE_WIDTH + COLUMN_GAP),
    height: PADDING * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * ROW_GAP,
    cyclicNodeIds,
  };
}

export function edgePath(from: PositionedNode, to: PositionedNode): string {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const bend = Math.max(24, (endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}
