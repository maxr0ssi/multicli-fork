import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:net';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalControlPlane } from '../../src/controlPlane/controlPlane.js';
import { mountLocalControlApi, type MountedLocalControlApi } from '../../src/controlPlane/httpApi.js';
import { StudioAuthManager } from '../../src/controlPlane/studioAuth.js';
import { workflowDraftSummary } from '../../src/controlPlane/workflowDrafts.js';
import type { Logger } from '../../src/logger.js';
import { createInMemoryRunLedger } from '../../src/persistence/runLedger.js';
import type { WorkflowRevision } from '../../src/workflows/domain.js';

const servers: HttpServer[] = [];
const controlPlanes: LocalControlPlane[] = [];
const controlApis: MountedLocalControlApi[] = [];

const canBindLoopback = await new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once('error', () => resolve(false));
  server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
});

function logger(): Logger {
  const value: Logger = {
    logPath: ':memory:', sessionId: 'draft-route-test', child: () => value,
    error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  };
  return value;
}

function workflow(): WorkflowRevision {
  return {
    id: 'route-workflow', revision: 40, name: 'Route workflow',
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
  };
}

async function setup(getCapabilities = () => ({ cliAvailability: { codex: true, claude: false } })) {
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
  controlPlanes.push(controlPlane);
  const controlApi = mountLocalControlApi({
    app,
    controlPlane,
    auth: new StudioAuthManager({ bearerToken: 'draft-bearer' }),
    logger: logger(),
    host: '127.0.0.1',
    renderStudio: () => '<!doctype html>',
    getCapabilities,
  });
  controlApis.push(controlApi);
  const server = await new Promise<HttpServer>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const controlApi of controlApis.splice(0)) controlApi.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const controlPlane of controlPlanes.splice(0)) controlPlane.close();
});

describe.skipIf(!canBindLoopback)('workflow draft control routes', () => {
  it('authenticates and durably moves an invalid edit through validation, publish, and fork', async () => {
    const baseUrl = await setup();
    const headers = {
      authorization: 'Bearer draft-bearer',
      'content-type': 'application/json',
    };
    expect((await fetch(`${baseUrl}/api/v1/workflow-drafts`)).status).toBe(401);

    const capabilities = await (await fetch(
      `${baseUrl}/api/v1/workflow-drafts/capabilities`,
      { headers },
    )).json() as any;
    expect(capabilities.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex', availability: 'available' }),
      expect.objectContaining({ id: 'claude', availability: 'unavailable' }),
    ]));
    const codexModels = capabilities.providers.find((provider: any) => provider.id === 'codex').models;
    expect(codexModels.map((model: any) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
    ]);
    expect(codexModels.find((model: any) => model.id === 'gpt-5.6-luna').reasoningEfforts)
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(codexModels.find((model: any) => model.id === 'gpt-5.6-sol').reasoningEfforts)
      .toContain('ultra');
    const claudeModels = capabilities.providers.find((provider: any) => provider.id === 'claude').models;
    expect(claudeModels.map((model: any) => model.id)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
    expect(claudeModels.every((model: any) => (
      model.reasoningEfforts.join(',') === 'low,medium,high,xhigh,max'
    ))).toBe(true);

    const createdResponse = await fetch(`${baseUrl}/api/v1/workflow-drafts`, {
      method: 'POST', headers,
      body: JSON.stringify({
        id: 'route-draft', workflowId: 'route-workflow', definition: workflow(),
        proposedRunInput: { objective: 'Build the beautiful swarm editor' },
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as any;
    expect(created).toMatchObject({ id: 'route-draft', version: 1, validation: { valid: true } });

    const list = await (await fetch(`${baseUrl}/api/v1/workflow-drafts`, { headers })).json() as any;
    expect(list.drafts[0]).toMatchObject({ id: created.id, nodeCount: 2 });
    expect(list.drafts[0]).not.toHaveProperty('definition');

    const invalidDefinition = { ...workflow(), edges: [] };
    const invalidSave = await fetch(`${baseUrl}/api/v1/workflow-drafts/${created.id}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ expectedVersion: 1, definition: invalidDefinition }),
    });
    expect(invalidSave.status).toBe(200);
    const invalid = await invalidSave.json() as any;
    expect(invalid.draft).toMatchObject({ version: 2, validation: { valid: false } });

    expect((await fetch(`${baseUrl}/api/v1/workflow-drafts/${created.id}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ expectedVersion: 1, definition: workflow() }),
    })).status).toBe(409);

    const rejected = await fetch(`${baseUrl}/api/v1/workflow-drafts/${created.id}/publish`, {
      method: 'POST', headers, body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ validation: { valid: false } });

    const repaired = await (await fetch(`${baseUrl}/api/v1/workflow-drafts/${created.id}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ expectedVersion: 2, definition: workflow() }),
    })).json() as any;
    const published = await (await fetch(
      `${baseUrl}/api/v1/workflow-drafts/${created.id}/publish`,
      { method: 'POST', headers, body: JSON.stringify({ expectedVersion: repaired.draft.version }) },
    )).json() as any;
    expect(published).toMatchObject({
      draft: { version: 4 },
      workflowRevision: { definition: { revision: 1 } },
    });

    const forkResponse = await fetch(`${baseUrl}/api/v1/workflow-drafts/${created.id}`, {
      method: 'PUT', headers,
      body: JSON.stringify({
        expectedVersion: published.draft.version,
        definition: { ...workflow(), name: 'Forked workflow' },
      }),
    });
    expect(forkResponse.status).toBe(201);
    const fork = await forkResponse.json() as any;
    expect(fork).toMatchObject({
      forkedFromDraftId: created.id,
      draft: {
        version: 1,
        baseRevisionId: published.workflowRevision.id,
        proposedRunInput: { objective: 'Build the beautiful swarm editor' },
      },
    });
    expect(fork.draft.id).not.toBe(created.id);
    expect(forkResponse.headers.get('location')).toContain(fork.draft.id);
  });

  it('assigns direct publishes monotonically and blocks unavailable providers before a run row exists', async () => {
    const baseUrl = await setup();
    const headers = {
      authorization: 'Bearer draft-bearer',
      'content-type': 'application/json',
    };
    const publish = async (definition: WorkflowRevision) => {
      const response = await fetch(`${baseUrl}/api/v1/workflows`, {
        method: 'POST', headers,
        body: JSON.stringify({ workflowId: 'route-workflow', definition }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<any>;
    };
    expect((await publish(workflow())).definition.revision).toBe(1);
    expect((await publish({ ...workflow(), name: 'Changed topology name' })).definition.revision)
      .toBe(2);

    const claudeWorkflow: WorkflowRevision = {
      id: 'claude-unavailable', revision: 1, name: 'Unavailable Claude',
      profiles: [{
        id: 'opus', label: 'Opus', role: 'reviewer', provider: 'claude',
        model: 'claude-opus-5', workspaceAccess: 'read-only',
        selection: 'explicit-only', enableSubagents: false,
      }],
      nodes: [
        { id: 'review', label: 'Review', kind: 'agent', profileId: 'opus', prompt: 'Review.' },
        { id: 'done', label: 'Done', kind: 'end' },
      ],
      edges: [{ from: 'review', to: 'done' }],
    };
    const revision = await (await fetch(`${baseUrl}/api/v1/workflows`, {
      method: 'POST', headers,
      body: JSON.stringify({ workflowId: claudeWorkflow.id, definition: claudeWorkflow }),
    })).json() as any;
    const start = await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ workflowRevisionId: revision.id }),
    });
    expect(start.status).toBe(422);
    expect(await start.json()).toMatchObject({
      validation: {
        valid: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('claude CLI is not available') }),
        ]),
      },
    });
    expect(await (await fetch(`${baseUrl}/api/v1/runs`, { headers })).json())
      .toEqual({ runs: [] });
  });

  it('rejects unsafe collection members and keeps legacy summaries defensive', async () => {
    const baseUrl = await setup();
    const headers = {
      authorization: 'Bearer draft-bearer',
      'content-type': 'application/json',
    };
    const response = await fetch(`${baseUrl}/api/v1/workflow-drafts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'malformed-list-draft',
        workflowId: 'malformed-list-workflow',
        definition: { name: 'Malformed entries', nodes: [null], profiles: [], edges: [] },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('nodes entries must be objects'),
    });

    const listResponse = await fetch(`${baseUrl}/api/v1/workflow-drafts`, { headers });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as any;
    expect(list.drafts).toHaveLength(0);

    expect(workflowDraftSummary({
      id: 'legacy-malformed',
      workflowId: 'legacy-workflow',
      version: 1,
      definition: {
        id: 'legacy-workflow', revision: 1, name: 'Legacy malformed',
        profiles: [], nodes: [null], edges: [],
      },
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    })).toMatchObject({
      id: 'legacy-malformed',
        name: 'Legacy malformed',
        nodeCount: 1,
        agentCount: 0,
        validation: { valid: false },
    });
  });

  it('preflights before publication and creates no revision for an unavailable provider', async () => {
    const baseUrl = await setup();
    const headers = { authorization: 'Bearer draft-bearer', 'content-type': 'application/json' };
    const unavailable = {
      ...workflow(), id: 'unavailable-workflow',
      profiles: [{
        id: 'opus', label: 'Opus', role: 'reviewer', provider: 'claude',
        model: 'claude-opus-5', workspaceAccess: 'read-only',
        selection: 'explicit-only', enableSubagents: false,
      }],
      nodes: [
        { id: 'review', label: 'Review', kind: 'agent', profileId: 'opus', prompt: 'Review.' },
        { id: 'done', label: 'Done', kind: 'end' },
      ],
      edges: [{ from: 'review', to: 'done' }],
    };
    const created = await (await fetch(`${baseUrl}/api/v1/workflow-drafts`, {
      method: 'POST', headers,
      body: JSON.stringify({
        id: 'unavailable-draft', workflowId: 'unavailable-workflow', definition: unavailable,
      }),
    })).json() as any;
    const response = await fetch(
      `${baseUrl}/api/v1/workflow-drafts/${created.id}/publish-and-start`,
      { method: 'POST', headers, body: JSON.stringify({ expectedVersion: 1, runId: 'run-unavailable' }) },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      validation: { issues: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('claude CLI is not available') }),
      ]) },
    });
    const unchanged = await (await fetch(
      `${baseUrl}/api/v1/workflow-drafts/${created.id}`,
      { headers },
    )).json() as any;
    expect(unchanged).toMatchObject({ version: 1 });
    expect(unchanged).not.toHaveProperty('publishedRevisionId');
    expect(await (await fetch(`${baseUrl}/api/v1/workflows`, { headers })).json())
      .toEqual({ workflows: [] });
    expect(await (await fetch(`${baseUrl}/api/v1/runs`, { headers })).json())
      .toEqual({ runs: [] });
  });

  it('replays a lost publish-and-start response to the exact revision and run', async () => {
    let codexAvailable = true;
    const baseUrl = await setup(() => ({ cliAvailability: { codex: codexAvailable, claude: false } }));
    const headers = { authorization: 'Bearer draft-bearer', 'content-type': 'application/json' };
    const created = await (await fetch(`${baseUrl}/api/v1/workflow-drafts`, {
      method: 'POST', headers,
      body: JSON.stringify({
        id: 'launch-draft', workflowId: 'route-workflow', definition: workflow(),
        proposedRunInput: { objective: 'Ship the reliable editor' },
      }),
    })).json() as any;
    const path = `${baseUrl}/api/v1/workflow-drafts/${created.id}/publish-and-start`;
    const request = {
      method: 'POST', headers,
      body: JSON.stringify({
        expectedVersion: created.version, runId: 'stable-launch-run',
        input: { objective: 'Ship the reliable editor', acceptanceCriteria: ['No duplicates'] },
      }),
    };
    const firstResponse = await fetch(path, request);
    const first = await firstResponse.json() as any;
    codexAvailable = false;
    const retryResponse = await fetch(path, request);
    const retry = await retryResponse.json() as any;

    expect(firstResponse.status).toBe(201);
    expect(retryResponse.status).toBe(200);
    expect(first).toMatchObject({ runCreated: true, run: { run: { id: 'stable-launch-run' } } });
    expect(retry).toMatchObject({
      runCreated: false,
      draft: { id: first.draft.id, version: first.draft.version },
      workflowRevision: { id: first.workflowRevision.id },
      run: { run: { id: first.run.run.id } },
    });
    expect((await (await fetch(`${baseUrl}/api/v1/workflows`, { headers })).json() as any).workflows)
      .toHaveLength(1);
    expect((await (await fetch(`${baseUrl}/api/v1/runs`, { headers })).json() as any).runs)
      .toHaveLength(1);
  });

  it('keeps both edit sets when a stale tab saves its local work as a new draft', async () => {
    const baseUrl = await setup();
    const headers = { authorization: 'Bearer draft-bearer', 'content-type': 'application/json' };
    const created = await (await fetch(`${baseUrl}/api/v1/workflow-drafts`, {
      method: 'POST', headers,
      body: JSON.stringify({ id: 'shared-draft', workflowId: 'route-workflow', definition: workflow() }),
    })).json() as any;
    const path = `${baseUrl}/api/v1/workflow-drafts/${created.id}`;
    const firstTab = await fetch(path, {
      method: 'PUT', headers,
      body: JSON.stringify({ expectedVersion: 1, definition: { ...workflow(), name: 'Tab A edit' } }),
    });
    expect(firstTab.status).toBe(200);
    const staleTab = await fetch(path, {
      method: 'PUT', headers,
      body: JSON.stringify({
        expectedVersion: 1,
        definition: { ...workflow(), name: 'Tab B edit' },
        proposedRunInput: { objective: 'Tab B objective' },
      }),
    });
    const conflict = await staleTab.json() as any;
    expect(staleTab.status).toBe(409);
    expect(conflict).toMatchObject({
      expectedVersion: 1,
      currentVersion: 2,
      recovery: {
        action: 'save-as-new-draft',
        label: 'Save my changes as a new draft',
        command: { method: 'POST', path: '/api/v1/workflow-drafts' },
      },
    });
    const clonedResponse = await fetch(`${baseUrl}${conflict.recovery.command.path}`, {
      method: conflict.recovery.command.method,
      headers,
      body: JSON.stringify(conflict.recovery.command.body),
    });
    const cloned = await clonedResponse.json() as any;
    expect(clonedResponse.status).toBe(201);
    expect(cloned).toMatchObject({
      definition: { name: 'Tab B edit' },
      proposedRunInput: { objective: 'Tab B objective' },
    });
    expect(cloned.id).not.toBe(created.id);
    expect(await (await fetch(path, { headers })).json())
      .toMatchObject({ definition: { name: 'Tab A edit' }, version: 2 });
  });
});
