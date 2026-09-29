import type { Server as HttpServer } from 'node:http';
import path from 'node:path';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';

import { loadConfig, type MultiCliConfig } from './config.js';
import type { LocalControlPlane } from './controlPlane/controlPlane.js';
import { mountLocalControlApi } from './controlPlane/httpApi.js';
import {
  StudioAuthManager,
  type StudioLaunchTarget,
} from './controlPlane/studioAuth.js';
import { McpHttpSessionHost } from './http/mcpSessions.js';
import {
  createAuthMiddleware,
  createOriginValidationMiddleware,
  validateHttpConfig,
} from './http/security.js';
import { createLogger, type Logger } from './logger.js';
import {
  createServerRuntime,
  type MultiCliRuntime,
} from './serverApp.js';
import { renderStudioDocument } from './studio/studioDocument.js';
import { StudioGoalSessionCommands } from './studio/server/goalSessionCommands.js';
import {
  CLAUDE_DEEP_DELIVERY,
  CLAUDE_DEEP_THINK,
} from './workflows/claudeWorkflows.js';
import { createHarmonyDeliveryWorkflow } from './workflows/dsl.js';
import { LUNA_BUILD_COUNCIL } from './workflows/lunaBuildCouncil.js';

export interface MultiCliHttpServer {
  readonly config: MultiCliConfig;
  readonly runtime: MultiCliRuntime;
  readonly controlPlane: LocalControlPlane;
  readonly url: string;
  readonly healthUrl: string;
  readonly studioUrl: string;
  readonly workspace: string;
  createStudioLaunchUrl(target?: StudioLaunchTarget): string;
  close(reason?: string): Promise<void>;
}

export interface StartHttpServerOptions {
  /** Repository used by workflow and persistent-session provider processes. */
  readonly workspace?: string;
}

export async function startHttpServer(
  config: MultiCliConfig = loadConfig(),
  rootLogger: Logger = createLogger({
    filePath: config.logPath,
    fileLevel: config.logLevel,
    stderrLevel: config.stderrLogLevel,
    bindings: { component: 'multicli' },
  }),
  runtime?: MultiCliRuntime,
  options: StartHttpServerOptions = {},
): Promise<MultiCliHttpServer> {
  validateHttpConfig(config);
  const ownsRuntime = runtime === undefined;
  const resolvedRuntime = runtime ?? await createServerRuntime(config, rootLogger);
  if (runtime) runtime.workflows.assertCompatible(config);
  const workspace = path.resolve(options.workspace ?? process.cwd());

  const logger = rootLogger.child({ component: 'httpServer' });
  let closing: Promise<void> | undefined;
  const workflowRuntime = resolvedRuntime.workflows.get(workspace);
  const { controlPlane, runner: workflowRunner, artifactRoot, orchestrator } = workflowRuntime;
  for (const definition of [
    LUNA_BUILD_COUNCIL,
    CLAUDE_DEEP_THINK,
    CLAUDE_DEEP_DELIVERY,
    createHarmonyDeliveryWorkflow(),
  ]) {
    controlPlane.publishWorkflow({ workflowId: definition.id, definition });
  }
  const studioAuth = new StudioAuthManager({
    bearerToken: config.httpAuthToken!,
    sessionTtlMs: config.studioSessionTtlMs,
  });
  const goalSessionCommands = new StudioGoalSessionCommands({
    controlPlane,
    sessions: orchestrator.goalSessions!,
    workspace,
    logger: rootLogger.child({ component: 'studioGoalSessions' }),
  });

  const app = createMcpExpressApp({ host: config.httpHost });
  app.use((_req: any, res: any, next: () => void) => {
    if (closing) { res.status(503).send('Server shutting down'); return; }
    next();
  });
  const originValidation = createOriginValidationMiddleware(logger, config.httpHost);
  const authValidation = createAuthMiddleware(logger, config.httpAuthToken!);
  const sessions = new McpHttpSessionHost({
    config,
    logger,
    rootLogger,
    runtime: resolvedRuntime,
  });
  const controlApi = mountLocalControlApi({
    app,
    auth: studioAuth,
    controlPlane,
    host: config.httpHost,
    logger: logger.child({ component: 'controlApi' }),
    renderStudio: renderStudioDocument,
    studio: {
      workspace,
      artifactRoot,
      goalSessionsEnabled: true,
      goalSessionCommands,
    },
    onRunStarted: (runId) => {
      void workflowRunner.execute(runId).catch(error => {
        logger.error('workflow_execution_failed', { runId, error });
      });
    },
    onRunControl: (runId, action) => {
      if (action === 'cancel') {
        workflowRunner.stop(runId, `Run ${action} requested`);
      } else if (action === 'resume') {
        void workflowRunner.execute(runId).catch(error => {
          logger.error('workflow_resume_failed', { runId, error });
        });
      }
    },
    onApprovalResolved: (approval) => {
      void workflowRunner.resolveGateApproval(approval).catch(error => {
        logger.error('workflow_gate_resolution_failed', {
          runId: approval.runId,
          approvalId: approval.id,
          error,
        });
      });
    },
    getCapabilities: () => ({
      locality: {
        controlPlane: 'loopback-only',
        state: 'local-sqlite',
        providerAccess: 'installed-cli-owned-auth',
        directProviderApiKeys: false,
      },
      profiles: {
        conductor: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
        builder: { model: 'gpt-5.6-luna', reasoningEffort: 'max' },
        terra: { model: 'gpt-5.6-terra', selection: 'explicit-only' },
        alternatives: [
          { model: 'claude-sonnet-5', reasoningEffort: 'high', selection: 'explicit-only' },
          { model: 'claude-opus-5', reasoningEffort: 'high', selection: 'explicit-only' },
        ],
      },
      cliAvailability: resolvedRuntime.availability,
      initializedAt: resolvedRuntime.initializedAt,
      features: {
        durableRuns: true,
        replayableEvents: true,
        approvals: true,
        artifacts: true,
        harness: true,
        studio: true,
        goalSessions: true,
      },
    }),
  });

  app.get('/health', (_req: any, res: any) => {
    res.json({
      ok: true,
      transport: 'http',
      sessions: sessions.size,
      path: config.httpPath,
      host: config.httpHost,
      port: config.httpPort,
      studio: controlApi.studioPath,
    });
  });
  sessions.mount(app, originValidation, authValidation);

  let listener: HttpServer;
  try {
    listener = await new Promise<HttpServer>((resolve, reject) => {
      const server = app.listen(config.httpPort, config.httpHost, (error?: Error) => {
        if (error) reject(error);
        else resolve(server);
      });
      server.once('error', reject);
    });
  } catch (error) {
    controlApi.close();
    studioAuth.close();
    await Promise.allSettled([
      sessions.close('HTTP startup failed'),
      goalSessionCommands.shutdown('HTTP startup failed'),
      ...(ownsRuntime ? [resolvedRuntime.workflows.close()] : []),
    ]);
    throw error;
  }

  logger.info('http_server_started', {
    host: config.httpHost,
    port: config.httpPort,
    path: config.httpPath,
  });

  void workflowRunner.recover().catch(error => {
    logger.error('workflow_recovery_failed', { error });
  });

  const address = listener.address();
  const listeningPort = address && typeof address !== 'string'
    ? address.port
    : config.httpPort;
  const baseUrl = `http://${config.httpHost}:${listeningPort}`;

  return {
    config,
    runtime: resolvedRuntime,
    controlPlane,
    url: `${baseUrl}${config.httpPath}`,
    healthUrl: `${baseUrl}/health`,
    studioUrl: `${baseUrl}${controlApi.studioPath}`,
    workspace,
    createStudioLaunchUrl(target = {}) {
      const nonce = studioAuth.issueLaunchNonce(target);
      return `${baseUrl}${controlApi.studioPath}/session?nonce=${encodeURIComponent(nonce)}`;
    },
    close(reason = 'HTTP server shutting down') {
      closing ??= (async () => {
        logger.info('http_server_closing', { reason, sessionCount: sessions.size });
        const listenerClosed = new Promise<void>((resolve, reject) => {
          listener.close(error => error ? reject(error) : resolve());
        });
        controlApi.close();
        studioAuth.close();
        const results = await Promise.allSettled([
          sessions.close(reason),
          goalSessionCommands.shutdown(reason),
          ...(ownsRuntime ? [resolvedRuntime.workflows.close()] : []),
          listenerClosed,
        ]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        logger.info('http_server_closed', { reason });
      })();
      return closing;
    },
  };
}
