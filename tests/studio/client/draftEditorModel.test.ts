import { describe, expect, it } from 'vitest';

import {
  addAgentNode,
  canAddNodeDependency,
  duplicateAgentNode,
  makeAgentProfileUnique,
  profileUseCount,
  removeAgentNode,
  setNodeDependency,
  updateWorkflowProfile,
  withWorkflowProfileModel,
} from '../../../src/studio/client/features/editor/draftEditorModel.js';
import type { WorkflowRevision } from '../../../src/workflows/domain.js';
import { validateLocalWorkflowRevision } from '../../../src/workflows/localModelPolicy.js';

function workflow(): WorkflowRevision {
  return {
    id: 'editor-test',
    revision: 2,
    name: 'Editor test',
    profiles: [{
      id: 'luna',
      label: 'Luna builder',
      role: 'builder',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'max',
      workspaceAccess: 'workspace-write',
      selection: 'default',
      enableSubagents: false,
    }],
    nodes: [
      { id: 'plan', kind: 'agent', label: 'Plan', profileId: 'luna', prompt: 'Plan.' },
      { id: 'end', kind: 'end', label: 'End' },
    ],
    edges: [{ from: 'plan', to: 'end' }],
  };
}

describe('Studio draft editor model', () => {
  it('adds a deliberately incomplete agent without inventing a provider or model', () => {
    const empty: WorkflowRevision = { ...workflow(), profiles: [], nodes: [], edges: [] };
    const result = addAgentNode(empty);
    const profile = result.definition.profiles[0];

    expect(result.selectedNodeId).toBe('new-agent');
    expect(profile.provider).toBe('');
    expect(profile.model).toBe('');
    expect(result.definition.nodes[0]).toMatchObject({ profileId: profile.id, prompt: '' });
  });

  it('inserts a new agent after the selected node without creating another root or end', () => {
    const result = addAgentNode(workflow(), 'plan');

    expect(result.definition.edges).toEqual([
      { from: 'plan', to: 'new-agent' },
      { from: 'new-agent', to: 'end' },
    ]);
  });

  it('duplicates an agent as a parallel branch with an independent profile', () => {
    const result = duplicateAgentNode(workflow(), 'plan')!;
    const copy = result.definition.nodes.find(node => node.id === result.selectedNodeId)!;

    expect(copy).toMatchObject({ kind: 'agent', label: 'Plan copy' });
    expect(result.definition.edges).toContainEqual({ from: copy.id, to: 'end' });
    expect(result.definition.profiles).toHaveLength(2);
    expect((copy as { profileId: string }).profileId).not.toBe('luna');
  });

  it('makes shared execution settings unique before changing them', () => {
    const added = addAgentNode(workflow(), 'plan').definition;
    expect(profileUseCount(added, 'luna')).toBe(2);

    const unique = makeAgentProfileUnique(added, 'new-agent');
    const node = unique.nodes.find(candidate => candidate.id === 'new-agent')!;
    const changed = updateWorkflowProfile(
      unique,
      (node as { profileId: string }).profileId,
      profile => ({ ...profile, model: 'gpt-5.6-sol' }),
    );

    expect(changed.profiles.find(profile => profile.id === 'luna')?.model)
      .toBe('gpt-5.6-luna');
    expect(changed.profiles.find(profile => profile.id !== 'luna')?.model)
      .toBe('gpt-5.6-sol');
  });

  it('applies Terra explicit-only policy in the same model edit', () => {
    const changed = updateWorkflowProfile(
      workflow(),
      'luna',
      profile => withWorkflowProfileModel(profile, 'gpt-5.6-terra'),
    );

    expect(changed.profiles[0]).toMatchObject({
      model: 'gpt-5.6-terra',
      selection: 'explicit-only',
    });
    expect(validateLocalWorkflowRevision(changed).valid).toBe(true);
  });

  it('drops an effort that the newly selected model does not support', () => {
    const changed = updateWorkflowProfile(
      workflow(),
      'luna',
      profile => withWorkflowProfileModel(
        { ...profile, model: 'gpt-5.6-sol', reasoningEffort: 'ultra' },
        'gpt-5.6-luna',
      ),
    );

    expect(changed.profiles[0].model).toBe('gpt-5.6-luna');
    expect(changed.profiles[0].reasoningEffort).toBeUndefined();
  });

  it('adds and removes exact dependencies without silently rewiring the graph', () => {
    const added = addAgentNode(workflow(), 'plan').definition;
    const withDependency = setNodeDependency(added, 'new-agent', 'plan', true);
    expect(withDependency.edges).toContainEqual({ from: 'plan', to: 'new-agent' });

    const removedDependency = setNodeDependency(withDependency, 'new-agent', 'plan', false);
    expect(removedDependency.edges).not.toContainEqual({ from: 'plan', to: 'new-agent' });

    const removedAgent = removeAgentNode(withDependency, 'new-agent');
    expect(removedAgent.nodes.some(node => node.id === 'new-agent')).toBe(false);
    expect(removedAgent.edges).toEqual([{ from: 'plan', to: 'end' }]);
  });

  it('does not offer a dependency that would create a cycle', () => {
    expect(canAddNodeDependency(workflow(), 'plan', 'end')).toBe(false);
    expect(canAddNodeDependency(workflow(), 'end', 'plan')).toBe(true);
    expect(canAddNodeDependency(workflow(), 'plan', 'plan')).toBe(false);
  });
});
