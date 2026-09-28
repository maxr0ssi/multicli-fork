import { describe, expect, it } from 'vitest';
import { askAntigravityTool } from '../../src/tools/ask-antigravity.tool.js';
import { askGeminiTool } from '../../src/tools/ask-gemini.tool.js';
import { askOpencodeTool } from '../../src/tools/ask-opencode.tool.js';
import { askClaudeTool } from '../../src/tools/ask-claude.tool.js';
import { askCodexTool } from '../../src/tools/ask-codex.tool.js';
import { importantReadNowTool } from '../../src/tools/important-read-now.tool.js';
import { getToolDefinitions } from '../../src/tools/registry.js';
import { claudeListModelsTool, codexListModelsTool, opencodeListModelsTool } from '../../src/tools/simple-tools.js';

const providers = [askAntigravityTool, askGeminiTool, askOpencodeTool, askClaudeTool, askCodexTool];

describe('provider tool contracts', () => {
  it.each(providers)('$name keeps required inputs and task execution support', tool => {
    expect(tool.zodSchema.safeParse({ prompt: 'Review this workspace.', model: 'test-model' }).success).toBe(true);
    expect(tool.zodSchema.safeParse({ prompt: '', model: 'test-model' }).success).toBe(false);
    expect(tool.zodSchema.safeParse({ prompt: 'Review this workspace.' }).success).toBe(false);
    expect(tool.execution?.taskSupport).toBe('optional');
  });

  it('describes capabilities without forcing delegation or promising unrestricted file access', () => {
    const definitions = JSON.stringify(getToolDefinitions([...providers, opencodeListModelsTool]));
    expect(definitions).not.toMatch(/MUST|CRITICAL|full filesystem access|1-15 min|delegate this call/i);
  });

  it('distinguishes bundled model catalogs from account availability', () => {
    for (const tool of [claudeListModelsTool, codexListModelsTool]) {
      expect(tool.description).toContain('bundled catalog');
      expect(tool.description).toContain('installed CLI and account');
    }
  });

  it('describes Claude system prompt replacement and explicit permission modes', () => {
    const [definition] = getToolDefinitions([askClaudeTool]);
    const properties = definition.inputSchema.properties as Record<string, { description: string; enum?: string[] }>;
    expect(properties.systemPrompt.description).toContain('Replace');
    expect(properties.systemPrompt.description).toContain('--system-prompt');
    expect(properties.permissionMode.enum).toContain('bypassPermissions');
    expect(properties.permissionMode.description).toContain('disables permission checks');
  });

  it('includes every supported CLI in detection troubleshooting', async () => {
    const message = await importantReadNowTool.execute({});
    for (const cli of ['codex', 'claude', 'agy', 'opencode']) expect(message).toContain(cli);
    expect(message).toContain("MCP server's PATH");
    expect(message).toContain('restart the MCP server');
  });
});
