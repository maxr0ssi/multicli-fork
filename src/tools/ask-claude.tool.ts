import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { executeClaudeCLI } from '../utils/claudeExecutor.js';
import { runConversationalTurn } from '../utils/conversationTurn.js';
import { ERROR_MESSAGES, STATUS_MESSAGES } from '../constants.js';
import { CLAUDE_REASONING_EFFORTS } from '../workflows/providerPolicy.js';

const askClaudeArgsSchema = z.object({
  prompt: z.string().min(1).describe("The question or task for Claude Code. Include the relevant workspace paths; the CLI can read files under its configured permissions."),
  model: z.string().min(1).describe("Model ID. Use List-Claude-Models to inspect available choices."),
  effort: z.enum(CLAUDE_REASONING_EFFORTS).optional().describe("Claude --effort value. Choose an effort supported by the selected model."),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan']).optional().describe("Claude --permission-mode value. Defaults to 'default'; 'acceptEdits' allows file edits and 'bypassPermissions' disables permission checks."),
  maxBudgetUsd: z.number().positive().optional().describe("Dollar limit forwarded to Claude Code's --max-budget-usd flag."),
  systemPrompt: z.string().optional().describe("Replace Claude Code's system prompt through --system-prompt."),
  conversationId: z.string().optional().describe('Starts a persistent session by default. Pass the returned handle to continue it, "new" to start another, or "none" for a one-shot call. Sessions stay pinned to their model, access mode, and directory.'),
});

export const askClaudeTool: UnifiedTool = {
  name: "Ask-Claude",
  description: "Ask Claude Code a question or delegate a task. Calls start persistent sessions by default; reuse the returned conversationId for follow-ups. Long-running calls have no default server timeout.",
  zodSchema: askClaudeArgsSchema,
  prompt: {
    description: "Execute 'claude --print <prompt>' to get Claude Code's response.",
  },
  category: 'claude',
  execution: { taskSupport: 'optional' },
  timeoutClass: 'ask',
  execute: async (args, context) => {
    const { prompt, model, effort, permissionMode, maxBudgetUsd, systemPrompt, conversationId } = args;

    if (!prompt?.trim()) {
      throw new Error(ERROR_MESSAGES.NO_PROMPT_PROVIDED);
    }

    const text = await runConversationalTurn({
      cli: 'claude',
      conversationId: conversationId as string | undefined,
      model: model as string,
      sandbox: (permissionMode as string | undefined) ?? 'default',
      cwd: context?.cwd ?? process.cwd(),
      // Claude accepts --session-id, so the id is minted rather than scraped.
      presetSessionId: true,
      run: ({ startSessionId, resumeSessionId }) => executeClaudeCLI(
        prompt as string,
        model as string,
        (permissionMode as string | undefined) ?? 'default',
        maxBudgetUsd as number | undefined,
        systemPrompt as string | undefined,
        context,
        startSessionId,
        resumeSessionId,
        { effort: effort as string | undefined },
      ),
    });

    return `${STATUS_MESSAGES.CLAUDE_RESPONSE}\n${text}`;
  }
};
