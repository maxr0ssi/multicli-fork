import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { executeCodexCLI } from '../utils/codexExecutor.js';
import { runConversationalTurn } from '../utils/conversationTurn.js';
import { ERROR_MESSAGES, STATUS_MESSAGES } from '../constants.js';
import { CODEX_REASONING_EFFORTS } from '../workflows/providerPolicy.js';

// Mirrors codexExecutor's default so the pinned sandbox matches what actually ran.
const DEFAULT_SANDBOX = 'read-only';

const askCodexArgsSchema = z.object({
  prompt: z.string().min(1).describe("The question or task for Codex. Include the relevant workspace paths; the CLI can read files under its configured permissions."),
  model: z.string().min(1).describe("Model ID. Use List-Codex-Models to inspect available choices."),
  effort: z.enum(CODEX_REASONING_EFFORTS).optional().describe("Codex reasoning effort. Choose an effort supported by the selected model."),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe("Codex sandbox mode: 'read-only' (default), 'workspace-write' for workspace edits, or 'danger-full-access' to disable sandbox restrictions."),
  conversationId: z.string().optional().describe('Starts a persistent session by default. Pass the returned handle to continue it, "new" to start another, or "none" for a one-shot call. Sessions stay pinned to their model, access mode, and directory.'),
});

export const askCodexTool: UnifiedTool = {
  name: "Ask-Codex",
  description: "Ask Codex a question or delegate a task. Calls start persistent sessions by default; reuse the returned conversationId for follow-ups. Long-running calls have no default server timeout.",
  zodSchema: askCodexArgsSchema,
  prompt: {
    description: "Execute 'codex exec <prompt>' to get Codex's response.",
  },
  category: 'codex',
  execution: { taskSupport: 'optional' },
  timeoutClass: 'ask',
  execute: async (args, context) => {
    const { prompt, model, effort, sandbox, conversationId } = args;

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
        { effort: effort as string | undefined },
      ),
    });

    return `${STATUS_MESSAGES.CODEX_RESPONSE}\n${text}`;
  }
};
