import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:net';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalControlPlane } from '../../src/controlPlane/controlPlane.js';
import { mountLocalControlApi } from '../../src/controlPlane/httpApi.js';
import type { MountedLocalControlApi } from '../../src/controlPlane/httpApi.js';
import {
  STUDIO_SESSION_COOKIE,
  StudioAuthManager,
} from '../../src/controlPlane/studioAuth.js';
import type { Logger } from '../../src/logger.js';
import { createInMemoryRunLedger } from '../../src/persistence/runLedger.js';
import { LUNA_BUILD_COUNCIL } from '../../src/workflows/lunaBuildCouncil.js';

const servers: HttpServer[] = [];
const controlPlanes: LocalControlPlane[] = [];
const controlApis: MountedLocalControlApi[] = [];

const canBindLoopback = await new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once('error', () => resolve(false));
  server.listen(0, '127.0.0.1', () => {
    server.close(() => resolve(true));
  });
});

function silentLogger(): Logger {
  const logger: Logger = {
    logPath: ':memory:',
    sessionId: 'test',
    child: () => logger,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return logger;
}

async function setup() {
  let token = 0;
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
  controlPlanes.push(controlPlane);
  const auth = new StudioAuthManager({
    bearerToken: 'test-bearer',
    createToken: () => `token-${token += 1}`,
  });
  const controlApi = mountLocalControlApi({
    app,
    auth,
    controlPlane,
    host: '127.0.0.1',
    logger: silentLogger(),
    renderStudio: () => '<!doctype html><title>Studio</title>',
    heartbeatMs: 25,
  });
  controlApis.push(controlApi);
  const server = await new Promise<HttpServer>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test address');
  return { auth, baseUrl: `http://127.0.0.1:${address.port}`, controlApi };
}

afterEach(async () => {
  for (const controlApi of controlApis.splice(0)) controlApi.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const controlPlane of controlPlanes.splice(0)) controlPlane.close();
});

describe.skipIf(!canBindLoopback)('local control API', () => {
  it('keeps Studio private and exchanges one-time launch links for browser sessions', async () => {
    const { auth, baseUrl } = await setup();
    expect((await fetch(`${baseUrl}/studio`)).status).toBe(401);

    const nonce = auth.issueLaunchNonce();
    const exchange = await fetch(`${baseUrl}/studio/session?nonce=${nonce}`, {
      redirect: 'manual',
    });
    const setCookie = exchange.headers.get('set-cookie')!;
    const cookie = setCookie.split(';')[0];
    expect(exchange.status).toBe(303);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect((await fetch(`${baseUrl}/studio/session?nonce=${nonce}`)).status).toBe(401);

    const studio = await fetch(`${baseUrl}/studio`, { headers: { cookie } });
    expect(studio.status).toBe(200);
    expect(await studio.text()).toContain('Studio');
  });

  it('requires browser CSRF while allowing bearer-authenticated automation', async () => {
    const { auth, baseUrl } = await setup();
    const session = auth.exchangeLaunchNonce(auth.issueLaunchNonce())!;
    const cookie = `${STUDIO_SESSION_COOKIE}=${session.id}`;
    const workflow = {
      workflowId: 'luna-council',
      definition: { ...LUNA_BUILD_COUNCIL, id: 'luna-council' },
    };

    expect((await fetch(`${baseUrl}/api/v1/workflows`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(workflow),
    })).status).toBe(403);

    const published = await fetch(`${baseUrl}/api/v1/workflows`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-multicli-csrf': session.csrfToken,
      },
      body: JSON.stringify(workflow),
    });
    expect(published.status).toBe(201);

    const capabilities = await fetch(`${baseUrl}/api/v1/capabilities`, {
      headers: { authorization: 'Bearer test-bearer' },
    });
    expect(await capabilities.json()).toMatchObject({
      locality: {
        providerAccess: 'installed-cli-owned-auth',
        directProviderApiKeys: false,
      },
      features: { durableRuns: true },
    });
  });

  it('starts runs and replays committed events over an authenticated SSE cursor', async () => {
    const { baseUrl } = await setup();
    const headers = {
      authorization: 'Bearer test-bearer',
      'content-type': 'application/json',
    };
    const revision = await (await fetch(`${baseUrl}/api/v1/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowId: 'sol-led',
        definition: { ...LUNA_BUILD_COUNCIL, id: 'sol-led' },
      }),
    })).json() as { id: string };
    const snapshot = await (await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workflowRevisionId: revision.id, input: { objective: 'Build it' } }),
    })).json() as { run: { id: string } };

    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl}/api/v1/runs/${snapshot.run.id}/events?after=0`,
      { headers: { authorization: 'Bearer test-bearer' }, signal: controller.signal },
    );
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    controller.abort();
    const payload = new TextDecoder().decode(chunk.value);

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(payload).toContain('id: 1');
    expect(payload).toContain('event: run-event');
    expect(payload).toContain('"type":"run.started"');
  });

  it('ends live event streams when the control API shuts down', async () => {
    const { baseUrl, controlApi } = await setup();
    const headers = {
      authorization: 'Bearer test-bearer',
      'content-type': 'application/json',
    };
    const revision = await (await fetch(`${baseUrl}/api/v1/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowId: 'shutdown-stream',
        definition: { ...LUNA_BUILD_COUNCIL, id: 'shutdown-stream' },
      }),
    })).json() as { id: string };
    const snapshot = await (await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workflowRevisionId: revision.id }),
    })).json() as { run: { id: string } };
    const response = await fetch(`${baseUrl}/api/v1/runs/${snapshot.run.id}/events`, {
      headers: { authorization: 'Bearer test-bearer' },
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);

    controlApi.close();

    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('rejects cross-origin control requests', async () => {
    const { baseUrl } = await setup();
    const response = await fetch(`${baseUrl}/api/v1/runs`, {
      headers: {
        authorization: 'Bearer test-bearer',
        origin: 'https://evil.example',
      },
    });
    expect(response.status).toBe(403);
  });
});
