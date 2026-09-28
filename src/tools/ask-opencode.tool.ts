import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { executeOpencodeCLI } from '../utils/opencodeExecutor.js';
import { ERROR_MESSAGES, STATUS_MESSAGES } from '../constants.js';

const askOpencodeArgsSchema = z.object({
  prompt: z.string().min(1).describe("The question or task for OpenCode. Include relevant workspace paths; file access follows the CLI configuration."),
  model: z.string().min(1).describe("Model ID in provider/model format from List-OpenCode-Models."),
});

export const askOpencodeTool: UnifiedTool = {
  name: "Ask-OpenCode",
  description: "Send a task to the installed OpenCode CLI using a configured provider/model.",
  zodSchema: askOpencodeArgsSchema,
  prompt: {
    description: "Execute 'opencode run <prompt> -m <model>' to get OpenCode's response.",
  },
  category: 'opencode',
  execution: { taskSupport: 'optional' },
  timeoutClass: 'ask',
  execute: async (args, context) => {
    const { prompt, model } = args;

    if (!prompt?.trim()) {
      throw new Error(ERROR_MESSAGES.NO_PROMPT_PROVIDED);
    }

    const result = await executeOpencodeCLI(
      prompt as string,
      model as string,
      context
    );

    return `${STATUS_MESSAGES.OPENCODE_RESPONSE}\n${result}`;
  }
};
