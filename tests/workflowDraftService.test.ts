import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LocalControlPlane } from '../src/controlPlane/controlPlane.js';
import {
  createInMemoryRunLedger,
  SqliteRunLedger,
} from '../src/persistence/runLedger.js';
import {
  createWorkflowDraftService,
  describeWorkflowDraftDesign,
  workflowDraftProposalSchema,
} from '../src/workflowDraftService.js';
import type { WorkflowDraftDefinition } from '../src/workflows/drafts.js';

function definition(model = 'gpt-5.6-sol'): WorkflowDraftDefinition {
  return {
    id: 'chat-proposal',
    revision: 1,
    name: 'Chat proposal',
    profiles: [{
      id: 'lead', label: 'Sol lead', role: 'conductor', provider: 'codex', model,
      reasoningEffort: 'high', workspaceAccess: 'read-only', selection: 'default',
      enableSubagents: false,
    }],
    nodes: [
      { id: 'plan', label: 'Plan', kind: 'agent', profileId: 'lead', prompt: 'Plan {{objective}}.' },
      { id: 'complete', label: 'Complete', kind: 'end' },
    ],
    edges: [{ from: 'plan', to: 'complete' }],
    metadata: { authoringSurface: 'chat' },
  };
}

function setup() {
  const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
  return { controlPlane, service: createWorkflowDraftService(controlPlane) };
}

describe('WorkflowDraftService', () => {
  it('persists the exact typed graph and extensible JSON-safe run input without publishing or running', () => {
    const { controlPlane, service } = setup();
    const graph = definition();
    const proposedRunInput = {
      objective: 'Build the workflow sculptor',
      acceptanceCriteria: ['The graph remains editable', 'No model starts'],
      constraints: ['Keep provider work local'],
      context: { repository: 'multicli', priorities: [1, true, null] },
      riskTolerance: 'low',
    };
    try {
      const result = service.propose({ definition: graph, proposedRunInput });
      const stored = controlPlane.getWorkflowDraft(result.draft.id);

      expect(stored.definition).toEqual(graph);
      expect(stored.proposedRunInput).toEqual(proposedRunInput);
      expect(result).toMatchObject({
        message: 'Here is the workflow I propose.',
        draft: { workflowId: graph.id, version: 1, validation: { valid: true } },
        topology: {
          nodeCount: 2,
          edgeCount: 1,
          agents: {
            items: [expect.objectContaining({
              nodeId: 'plan', model: 'gpt-5.6-sol', workspaceAccess: 'read-only',
              enableSubagents: false, resolution: 'resolved',
            })],
            omittedCount: 0,
            truncated: false,
          },
        },
        policy: {
          assignments: {
            items: [{ capKey: 'sol', assigned: 1, cap: 3, withinCap: true }],
            omittedCount: 0,
            truncated: false,
          },
          validationSource: 'local-workflow-validator',
        },
        effects: { persisted: true, published: false, runStarted: false },
      });
      expect(result.runInput.fields).toEqual({
        items: ['acceptanceCriteria', 'constraints', 'context', 'objective', 'riskTolerance'],
        omittedCount: 0,
        truncated: false,
      });
      expect(result.studio).toEqual({
        available: false,
        reason: 'Studio handoff requires an exact workspace.',
      });
      expect(controlPlane.ledger.listWorkflowRevisions()).toEqual([]);
      expect(controlPlane.listRuns()).toEqual([]);
    } finally {
      controlPlane.close();
    }
  });

  it('emits an exact Studio command only with workspace and file-backed store authority', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-draft-service-'));
    const workspace = path.join(directory, 'workspace');
    const storePath = path.join(directory, 'runs.sqlite');
    fs.mkdirSync(workspace);
    const controlPlane = new LocalControlPlane(new SqliteRunLedger(storePath));
    const service = createWorkflowDraftService(controlPlane);
    try {
      const available = service.propose({
        definition: definition(),
        proposedRunInput: { objective: 'Open the exact draft', workspace },
      }, { storePath });
      expect(available.studio.available).toBe(true);
      if (!available.studio.available) throw new Error(available.studio.reason);
      expect(available.studio).toMatchObject({
        command: `multicli studio --draft ${available.draft.id} --workspace ${workspace} --store ${storePath}`,
        launch: {
          command: 'multicli',
          args: [
            'studio', '--draft', available.draft.id,
            '--workspace', workspace, '--store', storePath,
          ],
        },
      });

      const missingWorkspace = service.propose({
        definition: definition(), proposedRunInput: { objective: 'Missing workspace' },
      }, { storePath });
      expect(missingWorkspace.studio).toEqual({
        available: false, reason: 'Studio handoff requires an exact workspace.',
      });

      const missingStore = service.propose({
        definition: definition(), proposedRunInput: { objective: 'Missing store', workspace },
      });
      expect(missingStore.studio).toEqual({
        available: false,
        reason: 'Studio handoff requires an exact file-backed SQLite store.',
      });

      const inMemory = service.propose({
        definition: definition(), proposedRunInput: { objective: 'Memory store', workspace },
      }, { storePath: ':memory:' });
      expect(inMemory.studio).toEqual({
        available: false,
        reason: 'Studio handoff is unavailable because this draft uses an in-memory ledger.',
      });
    } finally {
      controlPlane.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lets the server validator preserve and report a policy-invalid Fable proposal', () => {
    const { controlPlane, service } = setup();
    try {
      const result = service.propose({
        definition: definition('gpt-5.6-fable'),
        proposedRunInput: { objective: 'Test policy evidence' },
      });
      expect(result.draft.validation.valid).toBe(false);
      expect(result.draft.validation.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-profile' }),
        expect.objectContaining({ code: 'agent-cap-exceeded' }),
      ]));
      expect(result.policy.assignments.items).toEqual([
        expect.objectContaining({ capKey: 'fable', assigned: 1, cap: 0, withinCap: false }),
      ]);
      expect(service.get(result.draft.id).definition.profiles[0].model).toBe('gpt-5.6-fable');
    } finally {
      controlPlane.close();
    }
  });

  it('exposes explicit get, list, versioned update, and publish package operations', () => {
    const { controlPlane, service } = setup();
    try {
      const proposed = service.propose({
        definition: definition(),
        proposedRunInput: { objective: 'Exercise the package facade' },
      });
      expect(service.list('chat-proposal')).toEqual([
        expect.objectContaining({ id: proposed.draft.id, version: 1, nodeCount: 2 }),
      ]);
      expect(() => service.update({
        id: proposed.draft.id,
        expectedVersion: 1,
        definition: { ...definition(), id: 'different-workflow' },
      })).toThrow(/must remain/);

      const updated = service.update({
        id: proposed.draft.id,
        expectedVersion: 1,
        definition: { ...definition(), name: 'Refined proposal' },
        proposedRunInput: {
          objective: 'Exercise the package facade',
          acceptanceCriteria: ['Publish only through an explicit call'],
        },
      });
      expect(updated.draft).toMatchObject({
        version: 2,
        definition: { name: 'Refined proposal' },
      });
      const published = service.publish(updated.draft.id, updated.draft.version);
      expect(published).toMatchObject({
        draft: { version: 3, publishedRevisionId: published.workflowRevision.id },
        workflowRevision: { workflowId: 'chat-proposal', definition: { revision: 1 } },
      });
    } finally {
      controlPlane.close();
    }
  });

  it('bounds the chat receipt while retaining the complete durable graph', () => {
    const { controlPlane, service } = setup();
    const nodes = Array.from({ length: 201 }, (_, index) => ({
      id: `agent-${index + 1}`,
      label: `Agent ${index + 1}`,
      kind: 'agent' as const,
      profileId: 'lead',
      prompt: 'Review {{objective}}.',
    }));
    const large: WorkflowDraftDefinition = {
      ...definition(),
      nodes: [...nodes, { id: 'complete', label: 'Complete', kind: 'end' }],
      edges: [
        ...nodes.map((node, index) => ({
          from: node.id,
          to: index === nodes.length - 1 ? 'complete' : nodes[index + 1].id,
        })),
        ...Array.from({ length: 120 }, () => ({
          from: 'agent-1', to: 'agent-2',
        })),
      ],
    };
    try {
      const result = service.propose({
        definition: large,
        proposedRunInput: { objective: 'Bound the result' },
      });
      expect(result.topology.agents).toMatchObject({
        truncated: true, omittedCount: 101,
      });
      expect(result.topology.agents.items).toHaveLength(100);
      expect(result.topology.edges).toMatchObject({ truncated: true, omittedCount: 121 });
      expect(result.topology.edges.items).toHaveLength(200);
      expect(result.draft.validation).toMatchObject({
        valid: false,
        truncated: true,
      });
      expect(result.draft.validation.items).toHaveLength(100);
      expect(service.get(result.draft.id).definition.nodes).toHaveLength(202);
      expect(service.get(result.draft.id).definition.edges).toHaveLength(321);
    } finally {
      controlPlane.close();
    }
  });

  it('uses a non-authoritative revision placeholder and rejects lossy unknown definition fields', () => {
    const raw = definition() as Record<string, unknown>;
    delete raw.revision;
    expect(workflowDraftProposalSchema.parse({
      definition: raw,
      proposedRunInput: { objective: 'Default the draft revision' },
    }).definition.revision).toBe(1);
    expect(() => workflowDraftProposalSchema.parse({
      definition: { ...definition(), inventedExecutionMode: 'magic' },
      proposedRunInput: { objective: 'Reject lossy input' },
    })).toThrow();
    expect(() => workflowDraftProposalSchema.parse({
      definition: definition(),
      proposedRunInput: { objective: 'Reject non-JSON', context: undefined, invalid: () => true },
    })).toThrow();
  });

  it('describes the same schemas, policy, and observed CLI availability without constructing a runtime', () => {
    const design = describeWorkflowDraftDesign({
      cliAvailability: { codex: true, claude: false },
    });
    expect(design).toMatchObject({
      contractVersion: 1,
      workflowApi: { policy: { defaultBuilder: 'luna', fableRouting: 'disabled' } },
      proposal: {
        tool: 'Create-Workflow-Draft',
        effects: ['persist-editable-draft'],
        excludedEffects: ['publish-workflow', 'start-run', 'execute-model'],
        studioCommand:
          'multicli studio --draft <draftId> --workspace <workspace> --store <runStorePath>',
        studioAvailability: {
          requires: ['exact-workspace', 'file-backed-run-store'],
          unavailableFor: ['missing-authority', 'in-memory-run-store'],
        },
      },
    });
    expect(design.providerCapabilities.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex', availability: 'available' }),
      expect.objectContaining({ id: 'claude', availability: 'unavailable' }),
    ]));
    expect(design.proposal.definitionSchema).toHaveProperty('properties.nodes');
    expect(design.proposal.proposedRunInputSchema).toHaveProperty('properties.objective');
  });
});
