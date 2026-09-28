import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolRequest,
  type CallToolResult,
  type CreateTaskResult,
  type ListRootsResult,
  type ListToolsRequest,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { filterToolsForClient, isToolBlockedForClient } from '../clientFilter.js';
import type { MultiCliConfig } from '../config.js';
import type { ToolArguments } from '../constants.js';
import type { ToolExecutionContext } from '../execution.js';
import type { Logger } from '../logger.js';
import type { ManagedTaskStore } from '../taskStore.js';
import { importantReadNowTool } from '../tools/important-read-now.tool.js';
import {
  executeValidatedTool,
  getTool,
  getToolDefinitions,
  toolExists,
  toolRegistry,
  validateToolArguments,
} from '../tools/index.js';
import { CommandExecutionError } from '../utils/commandExecutor.js';
import { createProgressReporter, type ProgressReporter, type ProgressToken } from './progressReporter.js';
import type { MultiCliSessionContext, TaskExecution } from './types.js';

type HandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface RegisterToolHandlersOptions {
  server: Server;
  config: MultiCliConfig;
  logger: Logger;
  sessionContext: MultiCliSessionContext;
  taskStore: ManagedTaskStore;
  activeTasks: Map<string, TaskExecution>;
  getConnectedClientName(): string | undefined;
  resolveExecutionContext(logger: Logger): Promise<{
    cwd?: string;
    projectRoots?: ListRootsResult['roots'];
  }>;
}

function buildToolResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function buildErrorResult(toolName: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return buildToolResult(`Error executing ${toolName}: ${message}`, true);
}

function getTimeoutForTool(toolName: string, config: MultiCliConfig): number | undefined {
  switch (getTool(toolName)?.timeoutClass) {
    case 'ask':
      return config.askTimeoutMs;
    case 'help':
      return config.helpTimeoutMs;
    default:
      return undefined;
  }
}

function supportsTaskExecution(toolName: string): boolean {
  const support = getTool(toolName)?.execution?.taskSupport;
  return support === 'optional' || support === 'required';
}

function getErrorMeta(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof CommandExecutionError) {
    return {
      kind: error.kind,
      exitCode: error.details.exitCode,
      stderr: error.details.stderr,
    };
  }
  return error instanceof Error ? { error } : undefined;
}

function createExecutionContext(
  options: RegisterToolHandlersOptions,
  extra: HandlerExtra,
  toolName: string,
  requestLogger: Logger,
  progressReporter: ProgressReporter,
  resolved: { cwd?: string; projectRoots?: ListRootsResult['roots'] },
  signal: AbortSignal,
  taskId?: string,
): ToolExecutionContext {
  return {
    signal,
    onProgress: output => progressReporter.onOutput(output),
    timeoutMs: getTimeoutForTool(toolName, options.config),
    killGraceMs: options.config.killGraceMs,
    cwd: resolved.cwd,
    projectRoots: resolved.projectRoots,
    env: options.sessionContext.env,
    requestId: extra.requestId,
    taskId,
    logger: requestLogger,
  };
}

async function executeTask(
  options: RegisterToolHandlersOptions,
  extra: HandlerExtra,
  toolName: string,
  validatedArgs: ToolArguments,
  progressReporter: ProgressReporter,
  requestLogger: Logger,
  taskParams: { ttl?: number | null; pollInterval?: number },
): Promise<CreateTaskResult> {
  if (!supportsTaskExecution(toolName)) {
    throw new McpError(
      ErrorCode.MethodNotFound,
      `Tool "${toolName}" does not support task augmentation.`,
    );
  }
  if (!extra.taskStore) {
    throw new McpError(ErrorCode.InternalError, 'Task store not configured for task execution.');
  }

  const task = await extra.taskStore.createTask({
    ttl: taskParams.ttl ?? options.config.taskTtlMs,
    pollInterval: taskParams.pollInterval ?? options.config.taskPollIntervalMs,
  });
  const controller = new AbortController();
  options.activeTasks.set(task.taskId, { controller });
  options.taskStore.registerCancelHandler(task.taskId, reason => {
    requestLogger.info('task_cancellation_requested', { taskId: task.taskId, reason });
    controller.abort(new Error(reason ?? 'Task cancelled'));
  });

  const taskLogger = requestLogger.child({ component: 'taskExecution', taskId: task.taskId });
  const resolved = await options.resolveExecutionContext(taskLogger);
  const executionContext = createExecutionContext(
    options,
    extra,
    toolName,
    taskLogger,
    progressReporter,
    resolved,
    controller.signal,
    task.taskId,
  );
  requestLogger.info('task_created', { taskId: task.taskId, taskParams });

  void (async () => {
    await progressReporter.start();
    try {
      const tool = getTool(toolName);
      if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`);
      }
      const result = await executeValidatedTool(tool, validatedArgs, executionContext);
      await extra.taskStore!.storeTaskResult(
        task.taskId,
        'completed',
        buildToolResult(result, false),
      );
      await progressReporter.stop('success');
      taskLogger.info('task_completed', { taskId: task.taskId, resultLength: result.length });
    } catch (error) {
      const currentTask = await options.taskStore.getTask(task.taskId);
      if (currentTask?.status === 'cancelled' || controller.signal.aborted) {
        await progressReporter.stop('cancelled');
        taskLogger.info('task_cancelled', { taskId: task.taskId });
      } else {
        await extra.taskStore!.storeTaskResult(
          task.taskId,
          'failed',
          buildErrorResult(toolName, error),
        );
        await progressReporter.stop('failed');
        taskLogger.error('task_failed', { ...getErrorMeta(error) });
      }
    } finally {
      options.activeTasks.delete(task.taskId);
      options.taskStore.clearCancelHandler(task.taskId);
    }
  })().catch(error => {
    requestLogger.error('task_execution_unexpected_failure', { taskId: task.taskId, error });
  });

  return { task };
}

async function executeSynchronousTool(
  options: RegisterToolHandlersOptions,
  extra: HandlerExtra,
  toolName: string,
  validatedArgs: ToolArguments,
  progressReporter: ProgressReporter,
  requestLogger: Logger,
): Promise<CallToolResult> {
  await progressReporter.start();
  try {
    const executionLogger = options.logger.child({
      component: 'toolExecution',
      toolName,
      requestId: extra.requestId,
    });
    const resolved = await options.resolveExecutionContext(executionLogger);
    const executionContext = createExecutionContext(
      options,
      extra,
      toolName,
      executionLogger,
      progressReporter,
      resolved,
      extra.signal,
    );
    const tool = getTool(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    const result = await executeValidatedTool(tool, validatedArgs, executionContext);
    await progressReporter.stop('success');
    requestLogger.info('tool_request_completed', { resultLength: result.length });
    return buildToolResult(result, false);
  } catch (error) {
    const status = error instanceof CommandExecutionError && error.kind === 'cancelled'
      ? 'cancelled'
      : 'failed';
    await progressReporter.stop(status);
    requestLogger.error('tool_request_failed', { ...getErrorMeta(error) });
    return buildErrorResult(toolName, error);
  }
}

export function registerToolHandlers(options: RegisterToolHandlersOptions): () => boolean {
  let activeCalls = 0;
  const { server, logger } = options;

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request: ListToolsRequest): Promise<{ tools: Tool[] }> => {
      const connectedClientName = options.getConnectedClientName();
      const visible = filterToolsForClient(toolRegistry, connectedClientName);
      logger.debug('list_tools_requested', {
        connectedClientName,
        visibleToolNames: visible.map(tool => tool.name),
      });
      if (visible.length === 0) {
        return { tools: getToolDefinitions([importantReadNowTool]) as unknown as Tool[] };
      }
      return { tools: getToolDefinitions(visible) as unknown as Tool[] };
    },
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (
      request: CallToolRequest,
      extra: HandlerExtra,
    ): Promise<CallToolResult | CreateTaskResult> => {
      activeCalls += 1;
      try {
        const toolName = request.params.name;
        if (toolName === importantReadNowTool.name) {
          return buildToolResult(await importantReadNowTool.execute({}), false);
        }

        const connectedClientName = options.getConnectedClientName();
        if (isToolBlockedForClient(getTool(toolName), connectedClientName) || !toolExists(toolName)) {
          throw new Error(`Unknown tool: ${toolName}`);
        }

        const args = (request.params.arguments as ToolArguments) || {};
        const validatedArgs = validateToolArguments(toolName, args);
        const params = request.params as typeof request.params & {
          _meta?: { progressToken?: ProgressToken };
          task?: { ttl?: number | null; pollInterval?: number };
        };
        const progressToken = params._meta?.progressToken;
        const requestLogger = logger.child({
          component: 'toolRequest',
          requestId: extra.requestId,
          toolName,
        });
        const reporter = createProgressReporter(
          server,
          requestLogger,
          options.config,
          progressToken,
          toolName,
        );
        requestLogger.info('tool_request_started', {
          task: !!params.task,
          taskParams: params.task,
          progressToken,
          argumentKeys: Object.keys(validatedArgs).sort(),
        });

        if (params.task) {
          return await executeTask(
            options,
            extra,
            toolName,
            validatedArgs,
            reporter,
            requestLogger,
            params.task,
          );
        }
        return await executeSynchronousTool(
          options,
          extra,
          toolName,
          validatedArgs,
          reporter,
          requestLogger,
        );
      } finally {
        activeCalls -= 1;
      }
    },
  );
  return () => activeCalls > 0 || options.activeTasks.size > 0;
}
