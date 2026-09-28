import { CommandExecutionError, executeCommand } from './commandExecutor.js';
import { CLI } from '../constants.js';
import { ToolExecutionContext } from '../execution.js';
import { isValidNativeSessionId } from './conversationStore.js';
import { assertCallDepthAvailable, childEnv } from './callDepth.js';
import {
  enrichProviderCommandError,
  parseClaudeJson,
} from '../workflows/providerUsage.js';
import type { AttemptUsage } from '../workflows/domain.js';

export interface ClaudeResult {
  text: string;
  sessionId?: string;
  usage?: AttemptUsage;
}

export interface ClaudeOptions {
  /** Claude Code effort / adaptive-thinking depth. */
  effort?: string;
  /** Undefined preserves direct-tool behavior; workflows pass an explicit value. */
  enableSubagents?: boolean;
  /** Workflows request provider-reported usage; direct Ask tools keep plain text output. */
  captureUsage?: boolean;
}

export async function executeClaudeCLI(
  prompt: string,
  model: string,
  permissionMode?: string,
  maxBudgetUsd?: number,
  systemPrompt?: string,
  context?: ToolExecutionContext,
  // Turn 1 mints the id and passes it as `startSessionId`; later turns pass the
  // same value as `resumeSessionId`. Claude lets the caller choose the id up
  // front, so nothing has to be scraped out of its output.
  startSessionId?: string,
  resumeSessionId?: string,
  options: ClaudeOptions = {},
): Promise<ClaudeResult> {
  assertCallDepthAvailable('Claude Code');

  const args: string[] = [
    CLI.CLAUDE_FLAGS.PRINT,
    CLI.CLAUDE_FLAGS.OUTPUT_FORMAT, options.captureUsage ? "json" : "text",
    CLI.CLAUDE_FLAGS.MODEL, model,
    prompt,
  ];

  const sessionId = resumeSessionId ?? startSessionId;
  if (sessionId !== undefined) {
    if (!isValidNativeSessionId(sessionId)) {
      throw new Error(
        `Refusing to use a non-UUID claude session id: ${JSON.stringify(sessionId)}.`,
      );
    }

    args.push(
      resumeSessionId !== undefined ? '--resume' : '--session-id',
      sessionId,
    );
  }

  if (permissionMode) {
    args.push(CLI.CLAUDE_FLAGS.PERMISSION_MODE, permissionMode);
  }

  if (maxBudgetUsd !== undefined) {
    args.push(CLI.CLAUDE_FLAGS.MAX_BUDGET, String(maxBudgetUsd));
  }

  if (systemPrompt) {
    args.push(CLI.CLAUDE_FLAGS.SYSTEM_PROMPT, systemPrompt);
  }

  if (options.effort) {
    args.push('--effort', options.effort);
  }

  if (options.enableSubagents === false) {
    args.push('--disallowedTools', 'Agent,Task');
  }

  let output: string;
  try {
    output = await executeCommand(CLI.COMMANDS.CLAUDE, args, {
      ...context,
      env: childEnv(context?.env),
    });
  } catch (error) {
    if (options.captureUsage && error instanceof CommandExecutionError) {
      throw enrichProviderCommandError(error, error.details.stdout, parseClaudeJson);
    }
    throw error;
  }
  if (!options.captureUsage) return { text: output, sessionId };
  const parsed = parseClaudeJson(output);
  return { ...parsed, sessionId: parsed.sessionId ?? sessionId };
}
