import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { executeAntigravityCLI, processChangeModeOutput } from '../utils/antigravityExecutor.js';
import {
  ERROR_MESSAGES,
  STATUS_MESSAGES,
} from '../constants.js';

const askAntigravityArgsSchema = z.object({
  prompt: z.string().min(1).describe("The question or task for Antigravity. Reference workspace files with @path."),
  model: z.string().min(1).describe("Exact model name from List-Antigravity-Models."),
  sandbox: z.boolean().default(false).describe("Enable the Antigravity --sandbox flag. Defaults to false."),
  changeMode: z.boolean().default(false).describe("Return structured edit suggestions. Defaults to false."),
  chunkIndex: z.union([z.number(), z.string()]).optional().describe("One-based chunk index from a previous changeMode response."),
  chunkCacheKey: z.string().optional().describe("Cache key from a previous changeMode response."),
});

export const askAntigravityTool: UnifiedTool = {
  name: "Ask-Antigravity",
  description: "Send a task to the installed Antigravity CLI. Supports @file references and structured edit suggestions through changeMode.",
  zodSchema: askAntigravityArgsSchema,
  prompt: {
    description: "Execute 'agy --print <prompt>' to get Antigravity's response. Supports enhanced change mode for structured edit suggestions.",
  },
  category: 'antigravity',
  execution: { taskSupport: 'optional' },
  timeoutClass: 'ask',
  execute: async (args, context) => {
    const { prompt, model, sandbox, changeMode, chunkIndex, chunkCacheKey } = args;
    if (!prompt?.trim()) {
      throw new Error(ERROR_MESSAGES.NO_PROMPT_PROVIDED);
    }

    if (changeMode && chunkIndex && chunkCacheKey) {
      return processChangeModeOutput(
        '',
        chunkIndex as number,
        chunkCacheKey as string,
        prompt as string,
      );
    }

    const result = await executeAntigravityCLI(
      prompt as string,
      model as string,
      !!sandbox,
      !!changeMode,
      context,
    );

    if (changeMode) {
      return processChangeModeOutput(
        result,
        args.chunkIndex as number | undefined,
        undefined,
        prompt as string,
      );
    }

    return `${STATUS_MESSAGES.ANTIGRAVITY_RESPONSE}\n${result}`;
  },
};
