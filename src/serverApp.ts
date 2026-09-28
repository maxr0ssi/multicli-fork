import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ListRootsResult } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, type MultiCliConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { registerPromptHandlers } from './server/promptHandlers.js';
import {
  createServerRuntime,
  resolveWorkingDirectoryFromRoots,
} from './server/runtime.js';
import { registerToolHandlers } from './server/toolHandlers.js';
import type {
  CreateServerAppOptions,
  MultiCliServerApp,
  TaskExecution,
} from './server/types.js';
import { ManagedTaskStore } from './taskStore.js';

export { createServerRuntime, resolveWorkingDirectoryFromRoots } from './server/runtime.js';
export type {
  CreateServerAppOptions,
  MultiCliRuntime,
  MultiCliServerApp,
  MultiCliSessionContext,
} from './server/types.js';

function createRootLogger(config: MultiCliConfig): Logger {
  return createLogger({
    filePath: config.logPath,
    fileLevel: config.logLevel,
    stderrLevel: config.stderrLogLevel,
    bindings: { component: 'multicli' },
  });
}

export async function createServerApp(
  config: MultiCliConfig = loadConfig(),
  rootLogger: Logger = createRootLogger(config),
  options: CreateServerAppOptions = {},
): Promise<MultiCliServerApp> {
  const logger = rootLogger.child({ component: 'serverApp' });
  const sessionContext = options.sessionContext ?? {
    transport: 'stdio' as const,
    cwd: process.cwd(),
  };
  const runtime = options.runtime ?? await createServerRuntime(config, rootLogger);

  logger.info('server_app_initializing', { config, runtime, sessionContext });

  const taskStore = new ManagedTaskStore();
  const activeTasks = new Map<string, TaskExecution>();
  const server = new Server(
    {
      name: 'Multi-CLI',
      version: process.env.npm_package_version || '1.5.0',
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
      taskStore,
      defaultTaskPollInterval: config.taskPollIntervalMs,
    },
  );

  let connectedClientName: string | undefined;
  let closed = false;

  const resolveExecutionContext = async (requestLogger: Logger): Promise<{
    cwd?: string;
    projectRoots?: ListRootsResult['roots'];
  }> => {
    if (!sessionContext.cwd && !sessionContext.projectRoots) {
      const resolve = sessionContext.resolveWorkingDirectory;
      if (resolve) {
        const result = await resolve(
          server,
          requestLogger.child({ component: 'workingDirectory' }),
        );
        sessionContext.cwd = result.cwd ?? sessionContext.cwd;
        sessionContext.rootUri = result.rootUri ?? sessionContext.rootUri;
        sessionContext.projectRoots = result.projectRoots ?? sessionContext.projectRoots;
      }
    }

    return {
      cwd: sessionContext.cwd,
      projectRoots: sessionContext.projectRoots,
    };
  };

  const abortActiveTasks = (reason: string) => {
    logger.info('active_task_abort_started', {
      reason,
      activeTaskCount: activeTasks.size,
    });
    for (const [taskId, taskExecution] of activeTasks.entries()) {
      logger.info('active_task_aborting', { taskId, reason });
      taskExecution.controller.abort(new Error(reason));
    }
  };

  server.oninitialized = () => {
    const clientInfo = server.getClientVersion();
    connectedClientName = clientInfo?.name;
    sessionContext.clientName = connectedClientName;
    logger.info('client_initialized', {
      client: clientInfo,
      transport: sessionContext.transport,
    });
    void options.onClientInitialized?.(server, clientInfo, sessionContext);
  };

  server.onerror = error => {
    logger.error('server_error', { error });
  };
  server.onclose = () => {
    logger.info('server_transport_closed', {
      connectedClientName,
      activeTaskCount: activeTasks.size,
    });
  };

  const getConnectedClientName = () => connectedClientName;
  const hasActiveWork = registerToolHandlers({
    server,
    config,
    logger,
    sessionContext,
    taskStore,
    activeTasks,
    getConnectedClientName,
    resolveExecutionContext,
  });
  registerPromptHandlers(server, logger, getConnectedClientName);

  return {
    server,
    config,
    get hasActiveWork() { return hasActiveWork(); },
    async connect(transport: Transport) {
      logger.info('server_connect_started', { transport: transport.constructor.name });
      await server.connect(transport);
      logger.info('server_connect_completed', { transport: transport.constructor.name });
    },
    async close(reason = 'Server shutting down') {
      if (closed) {
        logger.debug('server_close_ignored', { reason });
        return;
      }

      closed = true;
      logger.info('server_close_started', { reason, activeTaskCount: activeTasks.size });
      abortActiveTasks(reason);
      taskStore.cleanup();
      await server.close();
      logger.info('server_close_completed', { reason });
    },
  };
}

export async function startServer(
  config: MultiCliConfig = loadConfig(),
  rootLogger: Logger = createRootLogger(config),
): Promise<MultiCliServerApp> {
  const logger = rootLogger.child({ component: 'startServer' });
  logger.info('stdio_server_starting', { config });
  const runtime = await createServerRuntime(config, rootLogger);
  const app = await createServerApp(config, rootLogger, {
    runtime,
    sessionContext: { transport: 'stdio', cwd: process.cwd() },
    onClientInitialized: async (server, _clientInfo, sessionContext) => {
      const resolved = await resolveWorkingDirectoryFromRoots(
        server,
        rootLogger.child({ component: 'stdioSession' }),
      );
      sessionContext.cwd = resolved.cwd ?? sessionContext.cwd;
      sessionContext.rootUri = resolved.rootUri;
      sessionContext.projectRoots = resolved.projectRoots;
    },
  });
  const transport = new StdioServerTransport();

  process.stdin.once('end', () => {
    logger.info('stdin_ended');
    void app.close('stdin ended');
  });
  process.stdin.once('close', () => {
    logger.info('stdin_closed');
    void app.close('stdin closed');
  });
  process.stdin.once('error', error => {
    logger.error('stdin_error', { error });
    void app.close('stdin error');
  });

  await app.connect(transport);
  logger.info('stdio_server_started', { transport: transport.constructor.name });
  return app;
}
