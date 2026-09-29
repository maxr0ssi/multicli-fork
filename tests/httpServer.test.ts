import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  ListRootsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

vi.mock('../src/utils/cliDetector.js', () => ({
  detectAvailableClis: vi.fn(),
}));

vi.mock('../src/utils/commandExecutor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/commandExecutor.js')>();
  return {
    ...actual,
    executeCommand: vi.fn(),
  };
});

import { detectAvailableClis } from '../src/utils/cliDetector.js';
import { executeCommand } from '../src/utils/commandExecutor.js';
import { WorkflowRuntimeOwner } from '../src/tools/workflow-tool-runtime.js';
import { createServerRuntime } from '../src/serverApp.js';
import { startHttpServer } from '../src/httpServer.js';
import type { MultiCliHttpServer } from '../src/httpServer.js';
import type { MultiCliConfig } from '../src/config.js';

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve ephemeral port'));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

const canBindLoopback = await new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once('error', () => resolve(false));
  server.listen(0, '127.0.0.1', () => {
    server.close(() => resolve(true));
  });
});

async function createHttpConfig(): Promise<MultiCliConfig> {
  const port = await findAvailablePort();
  const serviceRootDir = path.join(os.tmpdir(), `multicli-http-${process.pid}-${port}`);

  return {
    transport: 'http',
    askTimeoutMs: 1000,
    helpTimeoutMs: 500,
    cliDetectTimeoutMs: 100,
    killGraceMs: 50,
    taskTtlMs: 60_000,
    taskPollIntervalMs: 5,
    progressIdleHeartbeatMs: 25,
    progressThrottleMs: 1,
    httpHost: '127.0.0.1',
    httpPort: port,
    httpPath: '/mcp',
    httpAuthToken: 'test-token',
    httpSessionIdleMs: 60_000,
    studioSessionTtlMs: 60_000,
    runStorePath: path.join(serviceRootDir, 'runs.sqlite'),
    logPath: path.join(serviceRootDir, 'multicli.log'),
    logLevel: 'debug',
    stderrLogLevel: 'silent',
    serviceRootDir,
    serviceLogPath: path.join(serviceRootDir, 'logs', 'service.log'),
    serviceEnvPath: path.join(serviceRootDir, 'env'),
    serviceManifestPath: path.join(serviceRootDir, 'manifest.json'),
  };
}

describe.skipIf(!canBindLoopback)('httpServer', () => {
  let server: MultiCliHttpServer | undefined;
  let client: Client | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(detectAvailableClis).mockResolvedValue({
      antigravity: false,
      codex: false,
      claude: true,
      opencode: false,
    });
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    if (server) rmSync(server.config.serviceRootDir, { recursive: true, force: true });
    client = undefined;
    server = undefined;
    vi.restoreAllMocks();
  });

  it('rejects unauthenticated MCP requests', async () => {
    const config = await createHttpConfig();
    server = await startHttpServer(config);

    const response = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(401);
  });

  it('launches authenticated local Studio without exposing the bearer token', async () => {
    const config = await createHttpConfig();
    server = await startHttpServer(config);
    const launchUrl = server.createStudioLaunchUrl();

    expect(launchUrl).toContain('/studio/session?nonce=');
    expect(launchUrl).not.toContain(config.httpAuthToken!);
    const exchange = await fetch(launchUrl, { redirect: 'manual' });
    const cookie = exchange.headers.get('set-cookie')!.split(';')[0];
    expect(exchange.status).toBe(303);

    const studio = await fetch(server.studioUrl, { headers: { cookie } });
    expect(studio.status).toBe(200);
    expect(await studio.text()).toContain('Multi-CLI Studio');

    const capabilities = await fetch(
      server.studioUrl.replace('/studio', '/api/v1/capabilities'),
      { headers: { cookie } },
    );
    expect(await capabilities.json()).toMatchObject({
      locality: {
        providerAccess: 'installed-cli-owned-auth',
        directProviderApiKeys: false,
      },
      profiles: {
        builder: { model: 'gpt-5.6-luna', reasoningEffort: 'max' },
        terra: { selection: 'explicit-only' },
      },
    });
  });

  it('exchanges a targeted launch nonce into an authenticated draft route', async () => {
    const config = await createHttpConfig();
    server = await startHttpServer(config);
    const launchUrl = server.createStudioLaunchUrl({ draftId: 'draft-1' });

    expect(launchUrl).not.toContain('draft-1');
    expect(launchUrl).not.toContain(config.httpAuthToken!);
    const exchange = await fetch(launchUrl, { redirect: 'manual' });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get('location')).toBe('/studio?draft=draft-1');
    expect(exchange.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('uses an explicit Studio workspace for every workflow-facing projection', async () => {
    const config = await createHttpConfig();
    const workspace = path.join(config.serviceRootDir, 'target-workspace');
    mkdirSync(workspace, { recursive: true });
    server = await startHttpServer(config, undefined, undefined, { workspace });
    const exchange = await fetch(server.createStudioLaunchUrl(), { redirect: 'manual' });
    const cookie = exchange.headers.get('set-cookie')!.split(';')[0];
    const bootstrap = await fetch(
      server.studioUrl.replace('/studio', '/api/v1/studio/bootstrap'),
      { headers: { cookie } },
    );

    expect(server.workspace).toBe(workspace);
    expect(await bootstrap.json()).toMatchObject({ workspace });
  });

  it('closes the allocated runtime when the HTTP port cannot be bound', async () => {
    const config = await createHttpConfig();
    server = await startHttpServer(config);
    const closeFailedRuntime = vi.spyOn(WorkflowRuntimeOwner.prototype, 'close');
    await expect(startHttpServer(config)).rejects.toThrow(/EADDRINUSE/);
    expect(closeFailedRuntime).toHaveBeenCalledTimes(1);
    const failedOwner = closeFailedRuntime.mock.contexts[0];
    expect(() => failedOwner.get(server!.workspace)).toThrow('closed');
    expect(server.runtime.workflows.get(server.workspace).orchestrator.closed).toBe(false);
    expect((await fetch(server.healthUrl)).ok).toBe(true);
  });

  it('leaves a supplied runtime alive when a borrowing listener closes or fails to bind', async () => {
    const config = await createHttpConfig();
    const shared = await createServerRuntime(config);
    let second: MultiCliHttpServer | undefined;
    try {
      server = await startHttpServer(config, undefined, shared);
      second = await startHttpServer({ ...config, httpPort: await findAvailablePort() }, undefined, shared);
      const workflow = shared.workflows.get(server.workspace);
      const closeRuntime = vi.spyOn(workflow.orchestrator, 'close');
      await expect(startHttpServer(config, undefined, shared)).rejects.toThrow(/EADDRINUSE/);
      expect(workflow.orchestrator.closed).toBe(false);
      await expect(startHttpServer({ ...config, runStorePath: ':memory:' }, undefined, shared)).rejects.toThrow('must match');
      await server.close();
      expect(workflow.orchestrator.closed).toBe(false);
      expect(closeRuntime).not.toHaveBeenCalled();
      expect((await fetch(second.healthUrl)).ok).toBe(true);
      await second.close();
      expect(closeRuntime).not.toHaveBeenCalled();
      await shared.workflows.close();
      expect(closeRuntime).toHaveBeenCalledTimes(1);
    } finally {
      await second?.close();
      await shared.workflows.close();
    }
  });

  it('shares the configured workflow runtime with MCP and keeps it alive after a session closes', async () => {
    const config = await createHttpConfig();
    const environmentStore = path.join(config.serviceRootDir, 'ignored-environment.sqlite');
    vi.stubEnv('MULTICLI_RUN_STORE_PATH', environmentStore);
    try {
      server = await startHttpServer(config);
      const workflowRuntime = server.runtime.workflows.get(server.workspace);
      expect(workflowRuntime.controlPlane).toBe(server.controlPlane);
      const closeRuntime = vi.spyOn(workflowRuntime.orchestrator, 'close');
      const revision = server.controlPlane.ledger.listWorkflowRevisions()[0];
      const run = server.controlPlane.startRun({
        workflowRevisionId: revision.id,
        workspace: server.workspace,
        runInput: { objective: 'List this run without executing it' },
      });
      client = new Client({ name: 'http-test-client', version: '1.0.0' }, { capabilities: { roots: {} } });
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: [{ uri: pathToFileURL(server!.workspace).href }],
      }));
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: 'Bearer test-token' } },
      });
      await client.connect(transport);
      const result = await client.callTool({ name: 'List-Workflow-Runs', arguments: {} }, CallToolResultSchema);
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content[0].text as string).runs).toContainEqual(expect.objectContaining({ id: run.run.id }));
      expect(existsSync(environmentStore)).toBe(false);
      await transport.terminateSession();
      expect(workflowRuntime.orchestrator.closed).toBe(false);
      expect(closeRuntime).not.toHaveBeenCalled();
      await Promise.all([server.close(), server.close()]);
      expect(closeRuntime).toHaveBeenCalledTimes(1);
      expect(workflowRuntime.orchestrator.closed).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('expires idle sessions only after active tool work finishes', async () => {
    const config = await createHttpConfig();
    config.httpSessionIdleMs = 777_777;
    let expireSession: (() => void) | undefined;
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === config.httpSessionIdleMs) expireSession = callback as () => void;
      return realSetTimeout(callback, delay, ...args);
    });
    server = await startHttpServer(config);
    client = new Client({ name: 'http-test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: 'Bearer test-token' } },
    }));
    let finish: (value: string) => void;
    vi.mocked(executeCommand).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = client.callTool({
      name: 'Ask-Claude',
      arguments: { prompt: 'take your time', model: 'claude-sonnet-4-6' },
    }, CallToolResultSchema);
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalled());
    expect(expireSession).toBeDefined();
    expireSession!();
    expect(await (await fetch(server.healthUrl)).json()).toMatchObject({ sessions: 1 });
    finish!('finished');
    expect((await pending).isError).toBe(false);
    expireSession!();
    await vi.waitFor(async () => {
      expect(await (await fetch(server!.healthUrl)).json()).toMatchObject({ sessions: 0 });
    });
  });

  it('serves tool calls over HTTP and resolves the session working directory from roots', async () => {
    const config = await createHttpConfig();
    server = await startHttpServer(config);
    vi.mocked(executeCommand).mockResolvedValue('http response');

    client = new Client(
      { name: 'http-test-client', version: '1.0.0' },
      {
        capabilities: {
          roots: {},
          tasks: {
            list: {},
            cancel: {},
          },
        },
      },
    );

    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: 'file:///tmp/http-root' }],
    }));

    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: {
          Authorization: 'Bearer test-token',
        },
      },
    });

    await client.connect(transport);

    const result = await client.callTool(
      {
        name: 'Ask-Claude',
        arguments: {
          prompt: 'hello',
          model: 'claude-sonnet-4-6',
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('Claude response:\nhttp response');
    expect(executeCommand).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({
        cwd: '/tmp/http-root',
      }),
    );
  });
});
