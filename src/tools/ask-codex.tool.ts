import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { executeCodexCLI } from '../utils/codexExecutor.js';
import { runConversationalTurn } from '../utils/conversationTurn.js';
import { ERROR_MESSAGES, STATUS_MESSAGES } from '../constants.js';

// Mirrors codexExecutor's default so the pinned sandbox matches what actually ran.
const DEFAULT_SANDBOX = 'read-only';

const askCodexArgsSchema = z.object({
  prompt: z.string().min(1).describe("The question or task for Codex. REQUIRED — MUST be a non-empty string. Codex has FULL access to the filesystem and can read files itself. Do NOT pre-read or inline file contents — just describe the task and let Codex explore the codebase."),
  model: z.string().min(1).describe("REQUIRED — you MUST first call List-Codex-Models, review the available model families and their strengths, then select the best model for your task's scope and complexity. It's the law. Empty strings will be rejected."),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe("Optional. Defaults to 'read-only', which lets Codex read the codebase but NOT modify it. Only set this if the task genuinely requires Codex to change files: use 'workspace-write' to allow edits inside the working directory, or 'danger-full-access' for unrestricted access."),
  conversationId: z.string().optional().describe("Optional. Omit for a one-shot question with no memory of earlier calls. Pass \"new\" to start a persistent conversation: the reply ends with a conversation handle. Pass that handle back on later calls and Codex continues the same conversation, remembering everything said in it. A conversation is pinned to the model, sandbox and directory it was opened with."),
});

export const askCodexTool: UnifiedTool = {
  name: "Ask-Codex",
  description: "Ask OpenAI Codex a question or give it a task. Codex has full filesystem access and will read files itself — do NOT pre-gather context or inline file contents into the prompt. Just describe what you need. You MUST call List-Codex-Models first to select an appropriate model. Do NOT set optional parameters unless you have a specific reason. This tool is long-running (1-15 min); delegate this call to a sub-agent or background task.",
  zodSchema: askCodexArgsSchema,
  prompt: {
    description: "Execute 'codex exec <prompt> --full-auto' to get Codex's response.",
  },
  category: 'codex',
  execution: { taskSupport: 'optional' },
  timeoutClass: 'ask',
  execute: async (args, context) => {
    const { prompt, model, sandbox, conversationId } = args;

    if (!prompt?.trim()) {
      throw new Error(ERROR_MESSAGES.NO_PROMPT_PROVIDED);
    }

    const text = await runConversationalTurn({
      cli: 'codex',
      conversationId: conversationId as string | undefined,
      model: model as string,
      sandbox: (sandbox as string | undefined) ?? DEFAULT_SANDBOX,
      cwd: context?.cwd ?? process.cwd(),
      // Codex has no flag to choose a session id: it is scraped from the banner.
      presetSessionId: false,
      run: ({ resumeSessionId }) => executeCodexCLI(
        prompt as string,
        model as string,
        sandbox as string | undefined,
        undefined,
        context,
        resumeSessionId,
      ),
    });

    return `${STATUS_MESSAGES.CODEX_RESPONSE}\n${text}`;
  }
};
