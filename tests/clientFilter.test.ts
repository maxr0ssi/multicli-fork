import { describe, it, expect } from 'vitest';
import { getExcludedCategory, getExcludedCategories, filterToolsForClient, isToolBlockedForClient } from '../src/clientFilter.js';
import { type UnifiedTool } from '../src/tools/registry.js';

function mockTool(name: string, category: UnifiedTool['category']): UnifiedTool {
  return { name, category } as UnifiedTool;
}

const providers = [
  ['claude-code', 'claude'],
  ['codex-mcp-client', 'codex'],
  ['antigravity-cli-mcp-client', 'antigravity'],
  ['opencode', 'opencode'],
] as const;
const tools = [
  ...providers.map(([, category]) => mockTool(`Ask-${category}`, category)),
  mockTool('Utility', 'utility'),
];

describe('provider filtering', () => {
  it.each(providers)('hides and blocks only its own provider for %s', (client, category) => {
    expect(getExcludedCategory(client)).toBe(category);
    expect(getExcludedCategories(client)).toEqual([category]);
    const visible = filterToolsForClient(tools, client);
    expect(visible).toEqual(tools.filter(tool => tool.category !== category));
    expect(visible).toContain(tools.at(-1));
    for (const tool of tools) {
      expect(isToolBlockedForClient(tool, client)).toBe(tool.category === category);
    }
  });

  it.each(['unknown-client', 'gemini-cli-mcp-client', undefined])('does not alias an unknown client %s', client => {
    expect(getExcludedCategory(client)).toBeUndefined();
    expect(getExcludedCategories(client)).toEqual([]);
    expect(filterToolsForClient(tools, client)).toEqual(tools);
    for (const tool of tools) expect(isToolBlockedForClient(tool, client)).toBe(false);
  });

  it('does not treat a missing tool as a filtered category', () => {
    expect(isToolBlockedForClient(undefined, 'claude-code')).toBe(false);
  });
});
