import type { WorkflowRuntimeOwner } from '../tools/workflow-tool-runtime.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  Implementation,
  ListRootsResult,
} from '@modelcontextprotocol/sdk/types.js';

import type { MultiCliConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { CliAvailability } from '../utils/cliDetector.js';

export interface MultiCliRuntime {
  workflows: WorkflowRuntimeOwner;
  availability: CliAvailability;
  initializedAt: string;
}

export interface MultiCliSessionContext {
  cwd?: string;
  rootUri?: string;
  projectRoots?: ListRootsResult['roots'];
  env?: NodeJS.ProcessEnv;
  transport?: 'stdio' | 'http';
  clientName?: string;
  resolveWorkingDirectory?: (
    server: Server,
    logger: Logger,
  ) => Promise<{
    cwd?: string;
    rootUri?: string;
    projectRoots?: ListRootsResult['roots'];
  }>;
}

export interface CreateServerAppOptions {
  runtime?: MultiCliRuntime;
  sessionContext?: MultiCliSessionContext;
  onClientInitialized?: (
    server: Server,
    clientInfo: Implementation | undefined,
    sessionContext: MultiCliSessionContext,
  ) => Promise<void> | void;
}

export interface MultiCliServerApp {
  readonly server: Server;
  readonly config: MultiCliConfig;
  readonly hasActiveWork: boolean;
  connect(transport: Transport): Promise<void>;
  close(reason?: string): Promise<void>;
}

export interface TaskExecution {
  controller: AbortController;
}
