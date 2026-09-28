import { createHash } from 'node:crypto';
import { request as httpRequest, type Server as HttpServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalControlPlane } from '../../../src/controlPlane/controlPlane.js';
import { mountLocalControlApi } from '../../../src/controlPlane/httpApi.js';
import { StudioAuthManager } from '../../../src/controlPlane/studioAuth.js';
import type { Logger } from '../../../src/logger.js';
import { createInMemoryRunLedger } from '../../../src/persistence/runLedger.js';
import { StudioGoalSessionCommands } from '../../../src/studio/server/goalSessionCommands.js';
import { GoalSessionService } from '../../../src/workflows/goalSession.js';
import { createLunaBuildCouncilDefinition } from '../../../src/workflows/lunaBuildCouncil.js';

const servers: HttpServer[] = [];
const controls: LocalControlPlane[] = [];
const temporaryDirectories: string[] = [];

function logger(): Logger {
  const value: Logger = {
    logPath: ':memory:',
    sessionId: 'studio-routes-test',
    child: () => value,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return value;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const control of controls.splice(0)) control.close();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function setup() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-studio-routes-'));
  temporaryDirectories.push(workspace);
  const artifactRoot = path.join(workspace, 'artifacts');
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
  controls.push(controlPlane);
  const revision = controlPlane.publishWorkflow({
    workflowId: 'route-test',
    definition: {
      ...createLunaBuildCouncilDefinition({ builderCount: 2 }),
      id: 'route-test',
    },
  });
  const run = controlPlane.startRun({
    workflowRevisionId: revision.id,
    workspace,
    runInput: { objective: 'Inspect this run' },
  }).run;
  const directory = path.join(artifactRoot, run.id);
  fs.mkdirSync(directory, { recursive: true });
  const content = 'Authenticated artifact content';
  const location = path.join(directory, 'result.md');
  fs.writeFileSync(location, content);
  const artifact = controlPlane.recordArtifact({
    runId: run.id,
    contentHash: createHash('sha256').update(content).digest('hex'),
    mediaType: 'text/markdown',
    name: 'Result',
    location,
  });
  const executeGoalTurn = vi.fn(async () => ({
    text: 'Persistent turn complete',
    sessionId: '11111111-1111-4111-8111-111111111111',
  }));
  const goalSessions = new GoalSessionService({
    store: controlPlane.ledger,
    artifactRoot,
    executor: { execute: executeGoalTurn },
  });
  const goalSessionCommands = new StudioGoalSessionCommands({
    controlPlane,
    sessions: goalSessions,
    workspace,
    logger: logger(),
  });
  mountLocalControlApi({
    app,
    auth: new StudioAuthManager({ bearerToken: 'studio-route-token' }),
    controlPlane,
    host: '127.0.0.1',
    logger: logger(),
    renderStudio: () => '<!doctype html><title>Studio</title>',
    studio: {
      workspace,
      artifactRoot,
      goalSessionsEnabled: true,
      goalSessionCommands,
    },
  });
  const server = await new Promise<HttpServer>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return {
    artifact,
    baseUrl: `http://127.0.0.1:${address.port}`,
    content,
    controlPlane,
    executeGoalTurn,
    goalSessions,
    revision,
    run,
    workspace,
  };
}

async function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });
}

describe('Studio query routes', () => {
  it('authenticates bootstrap, run detail, and verified artifact preview', async () => {
    const { artifact, baseUrl, content, run } = await setup();
    expect((await fetch(`${baseUrl}/api/v1/studio/bootstrap`)).status).toBe(401);
    const headers = { authorization: 'Bearer studio-route-token' };
    expect(await requestStatus(`${baseUrl}/api/v1/studio/bootstrap`, {
      ...headers,
      host: 'evil.example',
    })).toBe(403);

    const bootstrapResponse = await fetch(`${baseUrl}/api/v1/studio/bootstrap`, { headers });
    const bootstrap = await bootstrapResponse.json() as { runs: Array<{ id: string }> };
    expect(bootstrap.runs[0].id).toBe(run.id);
    expect(bootstrapResponse.headers.get('cache-control')).toBe('no-store');

    const view = await (await fetch(
      `${baseUrl}/api/v1/runs/${run.id}/view`,
      { headers },
    )).json() as { workflow: { nodes: Array<{ id: string }> } };
    expect(view.workflow.nodes.length).toBeGreaterThan(0);

    const previewResponse = await fetch(
      `${baseUrl}/api/v1/runs/${run.id}/artifacts/${artifact.id}/content`,
      { headers },
    );
    expect(await previewResponse.json()).toMatchObject({ text: content, truncated: false });
    expect(previewResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(
      `${baseUrl}/api/v1/runs/not-this-run/artifacts/${artifact.id}/content`,
      { headers },
    )).status).toBe(404);
  });

  it('serves a strict authenticated shell and mounts durable goal commands', async () => {
    const { baseUrl, run } = await setup();
    const headers = { authorization: 'Bearer studio-route-token' };
    const shell = await fetch(`${baseUrl}/studio`, { headers });
    const policy = shell.headers.get('content-security-policy');
    expect(shell.status).toBe(200);
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain('unsafe-inline');
    expect((await fetch(`${baseUrl}/studio/assets/not-an-asset`, { headers })).status)
      .toBe(404);

    const opened = await fetch(`${baseUrl}/api/v1/goal-sessions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: run.id,
        profileId: 'luna-max-builder',
        goal: 'Direct this run over several durable turns.',
      }),
    });
    expect(opened.status).toBe(201);
    expect(await opened.json()).toMatchObject({
      runId: run.id,
      profileId: 'luna-max-builder',
      status: 'active',
    });
  });

  it('rejects a foreign-workspace goal command through the authenticated route', async () => {
    const { baseUrl, controlPlane, executeGoalTurn, revision } = await setup();
    const foreignWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-route-foreign-'));
    temporaryDirectories.push(foreignWorkspace);
    const foreignRun = controlPlane.startRun({
      workflowRevisionId: revision.id,
      workspace: foreignWorkspace,
    }).run;
    const response = await fetch(`${baseUrl}/api/v1/goal-sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer studio-route-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        runId: foreignRun.id,
        profileId: 'luna-max-builder',
        goal: 'Do not cross the Studio workspace.',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('is pinned to') });
    expect(executeGoalTurn).not.toHaveBeenCalled();
    expect(controlPlane.ledger.listGoalSessions(foreignRun.id)).toEqual([]);
  });
});
