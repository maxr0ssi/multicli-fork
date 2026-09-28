import type { Server as HttpServer } from 'node:http';
import path from 'node:path';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';

import { loadConfig, type MultiCliConfig } from './config.js';
import { LocalControlPlane } from './controlPlane/controlPlane.js';
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
import { SqliteRunLedger } from './persistence/runLedger.js';
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
import { LocalSubscriptionCliExecutor } from './workflows/executor.js';
import { GoalSessionService } from './workflows/goalSession.js';
import { LocalWorkflowRunner } from './workflows/runner.js';

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
  const resolvedRuntime = runtime ?? await createServerRuntime(config, rootLogger);
  const workspace = path.resolve(options.workspace ?? process.cwd());

  const logger = rootLogger.child({ component: 'httpServer' });
  const controlPlane = new LocalControlPlane(new SqliteRunLedger(config.runStorePath));
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
  const artifactRoot = path.join(path.dirname(config.runStorePath), 'artifacts');
  const providerExecutor = new LocalSubscriptionCliExecutor({
    killGraceMs: config.killGraceMs,
    logger: rootLogger.child({ component: 'workflowProvider' }),
  });
  const workflowRunner = new LocalWorkflowRunner({
    controlPlane,
    executor: providerExecutor,
    workspace,
    artifactRoot,
  });
  const goalSessions = new GoalSessionService({
    store: controlPlane.ledger,
    executor: providerExecutor,
    artifactRoot,
    onRunEvents: (runId, afterSequence) => {
      controlPlane.emitPersistedEvents(runId, afterSequence);
    },
  });
  const goalSessionCommands = new StudioGoalSessionCommands({
    controlPlane,
    sessions: goalSessions,
    workspace,
    logger: rootLogger.child({ component: 'studioGoalSessions' }),
  });

  const app = createMcpExpressApp({ host: config.httpHost });
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

  const listener = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(config.httpPort, config.httpHost, () => resolve(server));
    server.once('error', reject);
  });

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
    async close(reason = 'HTTP server shutting down') {
      logger.info('http_server_closing', {
        reason,
        sessionCount: sessions.size,
      });

      await sessions.close(reason);
      controlApi.close();
      studioAuth.close();
      await goalSessionCommands.shutdown(reason);
      await workflowRunner.close();

      await new Promise<void>((resolve, reject) => {
        listener.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      controlPlane.close();

      logger.info('http_server_closed', { reason });
    },
  };
}
