import type { WorkflowToolRuntime } from './tools/workflow-tool-runtime.js';
import type { Logger } from './logger.js';
import type { ListRootsResult } from '@modelcontextprotocol/sdk/types.js';

export type ToolTimeoutClass = 'ask' | 'help' | 'none';

export interface ToolExecutionContext {
  workflowRuntime?: (cwd: string) => WorkflowToolRuntime;
  signal?: AbortSignal;
  onProgress?: (newOutput: string) => void;
  /** Process-liveness callback; it does not imply that the model emitted text. */
  onHeartbeat?: () => void;
  heartbeatMs?: number;
  /** Explicit wall-clock ceiling, not an inactivity timeout. */
  timeoutMs?: number;
  killGraceMs?: number;
  cwd?: string;
  projectRoots?: ListRootsResult['roots'];
  env?: NodeJS.ProcessEnv;
  requestId?: string | number;
  taskId?: string;
  logger?: Logger;
}
