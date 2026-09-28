import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { executeGeminiCLI, processChangeModeOutput } from '../utils/geminiExecutor.js';
import { 
  ERROR_MESSAGES, 
  STATUS_MESSAGES
} from '../constants.js';

const askGeminiArgsSchema = z.object({
  prompt: z.string().min(1).describe("The question or task for Antigravity. Reference workspace files with @path."),
  model: z.string().min(1).describe("Exact model name from List-Antigravity-Models."),
  sandbox: z.boolean().default(false).describe("Enable the Antigravity --sandbox flag. Defaults to false."),
  changeMode: z.boolean().default(false).describe("Return structured edit suggestions. Defaults to false."),
  chunkIndex: z.union([z.number(), z.string()]).optional().describe("One-based chunk index from a previous changeMode response."),
  chunkCacheKey: z.string().optional().describe("Cache key from a previous changeMode response."),
});

export const askGeminiTool: UnifiedTool = {
  name: "Ask-Gemini",
  description: "Deprecated compatibility alias for Ask-Antigravity. Executes Google Antigravity via `agy`, not the legacy `gemini` binary. Use Ask-Antigravity for new workflows.",
  zodSchema: askGeminiArgsSchema,
  prompt: {
    description: "Deprecated alias: execute Antigravity via `agy --print <prompt>`. Supports enhanced change mode for structured edit suggestions.",
  },
  category: 'gemini',
  execution: { taskSupport: 'optional' },
  timeoutClass: 'ask',
  execute: async (args, context) => {
    const { prompt, model, sandbox, changeMode, chunkIndex, chunkCacheKey } = args; if (!prompt?.trim()) { throw new Error(ERROR_MESSAGES.NO_PROMPT_PROVIDED); }
  
    if (changeMode && chunkIndex && chunkCacheKey) {
      return processChangeModeOutput(
        '', // empty for cache...
        chunkIndex as number,
        chunkCacheKey as string,
        prompt as string
      );
    }
    
    const result = await executeGeminiCLI(
      prompt as string,
      model as string,
      !!sandbox,
      !!changeMode,
      context
    );
    
    if (changeMode) {
      return processChangeModeOutput(
        result,
        args.chunkIndex as number | undefined,
        undefined,
        prompt as string
      );
    }
    return `DEPRECATION: Ask-Gemini is a compatibility alias. This request was executed by Antigravity via \`agy\`. Use Ask-Antigravity for new workflows.\n\n${STATUS_MESSAGES.ANTIGRAVITY_RESPONSE}\n${result}`; // changeMode false
  }
};
