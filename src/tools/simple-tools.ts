import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { executeCommand } from '../utils/commandExecutor.js';
import { formatCatalog } from '../modelCatalog.js';
import { getOpencodeClassifiedCatalog } from '../utils/opencodeCatalog.js';
import { getAntigravityClassifiedCatalog } from '../utils/antigravityCatalog.js';
import { CLI } from '../constants.js';

const helpArgsSchema = z.object({});

export const antigravityHelpTool: UnifiedTool = {
  name: "Antigravity-Help",
  description: "Receive help information from the Antigravity CLI",
  zodSchema: helpArgsSchema,
  prompt: {
    description: "Receive help information from the Antigravity CLI",
  },
  category: 'antigravity',
  timeoutClass: 'help',
  execute: async (_args, context) => executeCommand(CLI.COMMANDS.ANTIGRAVITY, [CLI.ANTIGRAVITY_FLAGS.HELP], context),
};

export const codexHelpTool: UnifiedTool = {
  name: "Codex-Help",
  description: "Receive help information from the Codex CLI",
  zodSchema: helpArgsSchema,
  prompt: {
    description: "Receive help information from the Codex CLI",
  },
  category: 'codex',
  timeoutClass: 'help',
  execute: async (_args, context) => executeCommand("codex", ["--help"], context),
};

export const claudeHelpTool: UnifiedTool = {
  name: "Claude-Help",
  description: "Receive help information from the Claude Code CLI",
  zodSchema: helpArgsSchema,
  prompt: {
    description: "Receive help information from the Claude Code CLI",
  },
  category: 'claude',
  timeoutClass: 'help',
  execute: async (_args, context) => executeCommand("claude", ["--help"], context),
};

const noArgsSchema = z.object({});

export const antigravityListModelsTool: UnifiedTool = {
  name: "List-Antigravity-Models",
  description: "List Antigravity model names and tiers from `agy models`.",
  zodSchema: noArgsSchema,
  prompt: {
    description: "List available Antigravity models with tier classifications",
  },
  category: 'antigravity',
  execute: async (_args, context) => {
    return getAntigravityClassifiedCatalog(context);
  }
};

export const codexListModelsTool: UnifiedTool = {
  name: "List-Codex-Models",
  description: "List Codex model families and IDs from the bundled catalog. Availability depends on the installed CLI and account.",
  zodSchema: noArgsSchema,
  prompt: {
    description: "List available Codex models with family descriptions",
  },
  category: 'codex',
  execute: async () => {
    return formatCatalog('codex');
  }
};

export const claudeListModelsTool: UnifiedTool = {
  name: "List-Claude-Models",
  description: "List Claude model families and IDs from the bundled catalog. Availability depends on the installed CLI and account.",
  zodSchema: noArgsSchema,
  prompt: {
    description: "List available Claude models with family descriptions",
  },
  category: 'claude',
  execute: async () => {
    return formatCatalog('claude');
  }
};

export const opencodeHelpTool: UnifiedTool = {
  name: "OpenCode-Help",
  description: "Receive help information from the OpenCode CLI",
  zodSchema: helpArgsSchema,
  prompt: {
    description: "Receive help information from the OpenCode CLI",
  },
  category: 'opencode',
  timeoutClass: 'help',
  execute: async (_args, context) => executeCommand("opencode", ["--help"], context),
};

export const opencodeListModelsTool: UnifiedTool = {
  name: "List-OpenCode-Models",
  description: "List model IDs and tiers from OpenCode's configured providers.",
  zodSchema: noArgsSchema,
  prompt: {
    description: "List available OpenCode models with tier classifications",
  },
  category: 'opencode',
  execute: async () => {
    return getOpencodeClassifiedCatalog();
  }
};
