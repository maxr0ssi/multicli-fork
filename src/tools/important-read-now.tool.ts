import { z } from 'zod';
import { UnifiedTool } from './registry.js';

const noArgsSchema = z.object({});

const NO_CLI_MESSAGE = `No provider CLI tools are available to this client.

Install and authenticate at least one supported CLI on the MCP server's PATH:
  codex    OpenAI Codex
  claude   Anthropic Claude Code
  agy      Google Antigravity
  opencode OpenCode

A recognized client's own provider tools are hidden to avoid self-calls.
Check each installed CLI with --version, then restart the MCP server to refresh detection.
`;

export const importantReadNowTool: UnifiedTool = {
  name: "Multi-CLI-Help",
  description:
    "Explain provider CLI installation and detection when no provider tools are available.",
  zodSchema: noArgsSchema,
  category: 'utility',
  execute: async () => {
    return NO_CLI_MESSAGE;
  },
};
