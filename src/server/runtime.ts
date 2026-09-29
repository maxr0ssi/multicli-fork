import { fileURLToPath } from 'node:url';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ListRootsResult } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, type MultiCliConfig } from '../config.js';
import { createLogger, type Logger } from '../logger.js';
import { WorkflowRuntimeOwner } from '../tools/workflow-tool-runtime.js';
import { initTools } from '../tools/index.js';
import type { MultiCliRuntime } from './types.js';

export async function createServerRuntime(
  config: MultiCliConfig = loadConfig(),
  rootLogger: Logger = createLogger({
    filePath: config.logPath,
    fileLevel: config.logLevel,
    stderrLevel: config.stderrLogLevel,
    bindings: { component: 'multicli' },
  }),
): Promise<MultiCliRuntime> {
  const logger = rootLogger.child({ component: 'serverRuntime' });
  logger.info('server_runtime_initializing', { config });

  const availability = await initTools({
    cliDetectTimeoutMs: config.cliDetectTimeoutMs,
    logger: rootLogger.child({ component: 'cliDetector' }),
  });

  const runtime: MultiCliRuntime = {
    workflows: new WorkflowRuntimeOwner(config, rootLogger.child({ component: 'workflowRuntime' })),
    availability,
    initializedAt: new Date().toISOString(),
  };

  logger.info('server_runtime_initialized', { runtime });
  return runtime;
}

export async function resolveWorkingDirectoryFromRoots(
  server: Server,
  logger: Logger,
): Promise<{
  cwd?: string;
  rootUri?: string;
  projectRoots?: ListRootsResult['roots'];
}> {
  try {
    const rootsResult = await server.listRoots();
    const projectRoots = rootsResult.roots;
    const rootUri = rootsResult.roots.at(0)?.uri;
    if (!rootUri) {
      logger.info('session_roots_empty');
      return { projectRoots };
    }

    if (!rootUri.startsWith('file://')) {
      logger.error('session_root_uri_unsupported', { rootUri });
      return { rootUri, projectRoots };
    }

    const cwd = fileURLToPath(rootUri);
    logger.info('session_working_directory_resolved', {
      cwd,
      rootUri,
      projectRoots,
    });
    return { cwd, rootUri, projectRoots };
  } catch (error) {
    logger.error('session_working_directory_resolution_failed', { error });
    return {};
  }
}
