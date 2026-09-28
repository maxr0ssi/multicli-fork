import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  type GetPromptRequest,
  type GetPromptResult,
  type ListPromptsRequest,
  type Prompt,
} from '@modelcontextprotocol/sdk/types.js';

import { filterToolsForClient, isToolBlockedForClient } from '../clientFilter.js';
import type { Logger } from '../logger.js';
import {
  getPromptDefinitions,
  getPromptMessage,
  getTool,
  toolRegistry,
} from '../tools/index.js';

export function registerPromptHandlers(
  server: Server,
  logger: Logger,
  getConnectedClientName: () => string | undefined,
): void {
  server.setRequestHandler(
    ListPromptsRequestSchema,
    async (_request: ListPromptsRequest): Promise<{ prompts: Prompt[] }> => {
      const connectedClientName = getConnectedClientName();
      const visible = filterToolsForClient(toolRegistry, connectedClientName);
      logger.debug('list_prompts_requested', {
        connectedClientName,
        visiblePromptNames: visible.filter(tool => tool.prompt).map(tool => tool.name),
      });
      return { prompts: getPromptDefinitions(visible) as unknown as Prompt[] };
    },
  );

  server.setRequestHandler(
    GetPromptRequestSchema,
    async (request: GetPromptRequest): Promise<GetPromptResult> => {
      const promptName = request.params.name;
      if (isToolBlockedForClient(getTool(promptName), getConnectedClientName())) {
        throw new Error(`Unknown prompt: ${promptName}`);
      }

      const args = request.params.arguments || {};
      const promptMessage = getPromptMessage(promptName, args);
      if (!promptMessage) {
        throw new Error(`Unknown prompt: ${promptName}`);
      }

      logger.debug('get_prompt_requested', { promptName, arguments: args });
      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: promptMessage },
        }],
      };
    },
  );
}
