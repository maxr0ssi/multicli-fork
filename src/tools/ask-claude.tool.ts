import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { executeClaudeCLI } from '../utils/claudeExecutor.js';
import { runConversationalTurn } from '../utils/conversationTurn.js';
import { ERROR_MESSAGES, STATUS_MESSAGES } from '../constants.js';

const askClaudeArgsSchema = z.object({
  prompt: z.string().min(1).describe("The question or task for Claude Code. REQUIRED — MUST be a non-empty string. Claude Code has FULL access to the filesystem and can read files itself. Do NOT pre-read or inline file contents — just describe the task and let Claude explore the codebase."),
  model: z.string().min(1).describe("REQUIRED — you MUST first call List-Claude-Models, review the available model families and their strengths, then select the best model for your task's scope and complexity. It's the law. Empty strings will be rejected."),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan']).optional().describe("Optional. Do NOT set unless explicitly needed. Permission mode: 'default' (requires approval), 'acceptEdits' (auto-accepts file edits), 'bypassPermissions' (skips all checks — use with care), 'dontAsk', or 'plan'."),
  maxBudgetUsd: z.number().positive().optional().describe("Optional. Do NOT set unless explicitly needed. Maximum dollar amount to spend on API calls for this request."),
  systemPrompt: z.string().optional().describe("Optional. Do NOT set unless explicitly needed. Override or append a system prompt for this request."),
  conversationId: z.string().optional().describe("Optional. Omit for a one-shot question with no memory of earlier calls. Pass \"new\" to start a persistent conversation: the reply ends with a conversation handle. Pass that handle back on later calls and Claude continues the same conversation, remembering everything said in it. A conversation is pinned to the model and directory it was opened with."),
});

export const askClaudeTool: UnifiedTool = {
  name: "Ask-Claude",
  description: "Ask Claude Code a question or give it a task. Claude Code has full filesystem access and will read files itself — do NOT pre-gather context or inline file contents into the prompt. Just describe what you need. You MUST call List-Claude-Models first to select an appropriate model. Do NOT set optional parameters unless you have a specific reason. This tool is long-running (1-15 min); delegate this call to a sub-agent or background task.",
  zodSchema: askClaudeArgsSchema,
  prompt: {
    description: "Execute 'claude --print <prompt>' to get Claude Code's response.",
  },
  category: 'claude',
  execution: { taskSupport: 'optional' },
  timeoutClass: 'ask',
  execute: async (args, context) => {
    const { prompt, model, permissionMode, maxBudgetUsd, systemPrompt, conversationId } = args;

    if (!prompt?.trim()) {
      throw new Error(ERROR_MESSAGES.NO_PROMPT_PROVIDED);
    }

    const text = await runConversationalTurn({
      cli: 'claude',
      conversationId: conversationId as string | undefined,
      model: model as string,
      // Claude Code enforces its own permissions and denies writes by default,
      // so there is no sandbox to pin here.
      sandbox: 'n/a',
      cwd: context?.cwd ?? process.cwd(),
      // Claude accepts --session-id, so the id is minted rather than scraped.
      presetSessionId: true,
      run: ({ startSessionId, resumeSessionId }) => executeClaudeCLI(
        prompt as string,
        model as string,
        permissionMode as string | undefined,
        maxBudgetUsd as number | undefined,
        systemPrompt as string | undefined,
        context,
        startSessionId,
        resumeSessionId,
      ),
    });

    return `${STATUS_MESSAGES.CLAUDE_RESPONSE}\n${text}`;
  }
};
