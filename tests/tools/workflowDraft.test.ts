import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LocalControlPlane } from '../../src/controlPlane/controlPlane.js';
import {
  createInMemoryRunLedger,
  SqliteRunLedger,
} from '../../src/persistence/runLedger.js';
import { getToolDefinitions } from '../../src/tools/registry.js';
import { createWorkflowDraftTools } from '../../src/tools/workflow-draft.tool.js';
import { parseStudioLaunchArgs } from '../../src/studio/launcher.js';

function proposal() {
  return {
    definition: {
      id: 'tool-proposal', revision: 1, name: 'Tool proposal',
      profiles: [{
        id: 'luna', label: 'Luna', role: 'builder', provider: 'codex',
        model: 'gpt-5.6-luna', reasoningEffort: 'max', workspaceAccess: 'workspace-write',
        selection: 'default', enableSubagents: false,
      }],
      nodes: [
        { id: 'build', label: 'Build', kind: 'agent', profileId: 'luna', prompt: 'Build.' },
        { id: 'done', label: 'Done', kind: 'end' },
      ],
      edges: [{ from: 'build', to: 'done' }],
    },
    proposedRunInput: {
      objective: 'Build the tactile editor',
      acceptanceCriteria: ['The draft opens in Studio'],
      context: { source: 'chat' },
      workspace: '/agent-suggested-wrong-workspace',
    },
  };
}

describe('workflow draft MCP tools', () => {
  it('exposes explicit read and create annotations with strong nested schemas', () => {
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    try {
      const tools = createWorkflowDraftTools({
        getRuntime: () => ({ controlPlane, storePath: '/tmp/custom workflow.sqlite' }),
      });
      const definitions = getToolDefinitions([
        tools.describeWorkflowDesignTool,
        tools.createWorkflowDraftTool,
      ]);
      expect(definitions[0]).toMatchObject({
        name: 'Describe-Workflow-Design',
        annotations: {
          readOnlyHint: true, destructiveHint: false, openWorldHint: false,
          idempotentHint: true,
        },
      });
      expect(definitions[1]).toMatchObject({
        name: 'Create-Workflow-Draft',
        annotations: {
          readOnlyHint: false, destructiveHint: false, openWorldHint: false,
          idempotentHint: false,
        },
      });
      expect(definitions[1].description).toContain(
        '--draft <id> --workspace <workspace> --store <runStorePath>',
      );
      expect(definitions[1].description).toContain('In-memory ledgers');
      expect(definitions[1].inputSchema).toHaveProperty('properties.definition');
      expect(definitions[1].inputSchema).toHaveProperty('$defs');
      expect(() => tools.createWorkflowDraftTool.zodSchema.parse({
        ...proposal(),
        definition: { ...proposal().definition, nodes: [{ kind: 'imaginary' }] },
      })).toThrow();
    } finally {
      controlPlane.close();
    }
  });

  it('persists a draft and returns a secure CLI handoff without publishing or executing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-draft-tool-'));
    const storePath = path.join(directory, 'custom workflow.sqlite');
    const workspace = path.join(directory, 'Workspace with spaces');
    fs.mkdirSync(workspace);
    const controlPlane = new LocalControlPlane(new SqliteRunLedger(storePath));
    let reopened: LocalControlPlane | undefined;
    try {
      const tools = createWorkflowDraftTools({
        getRuntime: () => ({ controlPlane, storePath }),
      });
      const result = JSON.parse(await tools.createWorkflowDraftTool.execute(
        proposal() as never,
        { cwd: workspace },
      ));
      expect(result).toMatchObject({
        message: 'Here is the workflow I propose.',
        draft: { workflowId: 'tool-proposal', version: 1, validation: { valid: true } },
        effects: { persisted: true, published: false, runStarted: false },
      });
      expect(result.studio).toMatchObject({
        available: true,
        launch: {
          command: 'multicli',
          args: [
            'studio', '--draft', result.draft.id,
            '--workspace', fs.realpathSync(workspace),
            '--store', storePath,
          ],
        },
      });
      expect(result.studio.command).toContain(`--workspace '${fs.realpathSync(workspace)}'`);
      expect(result.studio.command).toContain(`--store '${storePath}'`);
      expect(controlPlane.getWorkflowDraft(result.draft.id).proposedRunInput).toEqual({
        ...proposal().proposedRunInput,
        workspace: fs.realpathSync(workspace),
      });
      expect(controlPlane.ledger.listWorkflowRevisions()).toEqual([]);
      expect(controlPlane.listRuns()).toEqual([]);
      expect(parseStudioLaunchArgs(result.studio.launch.args.slice(1), directory)).toMatchObject({
        target: { draftId: result.draft.id },
        workspace: fs.realpathSync(workspace),
        storePath: fs.realpathSync(storePath),
      });
      reopened = new LocalControlPlane(new SqliteRunLedger(storePath));
      expect(reopened.getWorkflowDraft(result.draft.id)).toMatchObject({
        id: result.draft.id,
        proposedRunInput: { workspace: fs.realpathSync(workspace) },
      });
    } finally {
      reopened?.close();
      controlPlane.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns an explicit unavailable handoff for an in-memory MCP ledger', async () => {
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    try {
      const tools = createWorkflowDraftTools({
        getRuntime: () => ({ controlPlane, storePath: ':memory:' }),
      });
      const result = JSON.parse(await tools.createWorkflowDraftTool.execute(
        proposal() as never,
        { cwd: process.cwd() },
      ));
      expect(result.studio).toEqual({
        available: false,
        reason: 'Studio handoff is unavailable because this draft uses an in-memory ledger.',
      });
      expect(controlPlane.getWorkflowDraft(result.draft.id)).toMatchObject({
        id: result.draft.id,
        proposedRunInput: { workspace: fs.realpathSync(process.cwd()) },
      });
    } finally {
      controlPlane.close();
    }
  });

  it('reports detected provider availability from the read-only design tool', async () => {
    const tools = createWorkflowDraftTools({
      runtimeCapabilities: { cliAvailability: { codex: false, claude: true } },
    });
    const result = JSON.parse(await tools.describeWorkflowDesignTool.execute({}));
    expect(result.providerCapabilities.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex', availability: 'unavailable' }),
      expect.objectContaining({ id: 'claude', availability: 'available' }),
    ]));
  });
});
