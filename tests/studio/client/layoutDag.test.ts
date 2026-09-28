import { describe, expect, it } from 'vitest';

import {
  edgePath,
  layoutDag,
} from '../../../src/studio/client/features/graph/layoutDag.js';
import type {
  WorkflowEdge,
  WorkflowNode,
} from '../../../src/workflows/domain.js';

const nodes: WorkflowNode[] = [
  { id: 'plan', kind: 'agent', label: 'Plan', profileId: 'sol', prompt: 'Plan' },
  { id: 'split', kind: 'fanout', label: 'Split' },
  { id: 'build-a', kind: 'agent', label: 'Build A', profileId: 'luna', prompt: 'Build' },
  { id: 'build-b', kind: 'agent', label: 'Build B', profileId: 'luna', prompt: 'Build' },
  { id: 'join', kind: 'join', label: 'Join', strategy: 'all' },
  { id: 'end', kind: 'end', label: 'End' },
];

const edges: WorkflowEdge[] = [
  { from: 'plan', to: 'split' },
  { from: 'split', to: 'build-a' },
  { from: 'split', to: 'build-b' },
  { from: 'build-a', to: 'join' },
  { from: 'build-b', to: 'join' },
  { from: 'join', to: 'end' },
];

describe('Studio DAG layout', () => {
  it('places dependencies in deterministic layers and parallel nodes in separate rows', () => {
    const first = layoutDag(nodes, edges);
    const second = layoutDag(nodes, [...edges].reverse());
    const positions = new Map(first.nodes.map(node => [node.node.id, node]));

    expect(second).toEqual(first);
    expect(positions.get('plan')!.layer).toBe(0);
    expect(positions.get('split')!.layer).toBe(1);
    expect(positions.get('build-a')!.layer).toBe(2);
    expect(positions.get('build-b')!.layer).toBe(2);
    expect(positions.get('build-a')!.y).not.toBe(positions.get('build-b')!.y);
    expect(positions.get('end')!.layer).toBe(4);
    expect(edgePath(positions.get('plan')!, positions.get('split')!)).toMatch(/^M .* C /);
  });

  it('surfaces cyclic nodes without recursing forever', () => {
    const cyclic = layoutDag(nodes.slice(0, 2), [
      { from: 'plan', to: 'split' },
      { from: 'split', to: 'plan' },
    ]);

    expect(cyclic.cyclicNodeIds).toEqual(['plan', 'split']);
    expect(cyclic.nodes).toHaveLength(2);
  });
});
