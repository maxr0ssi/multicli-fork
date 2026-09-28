import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  codex: vi.fn(),
  claude: vi.fn(),
}));

vi.mock('../../src/utils/codexExecutor.js', () => ({ executeCodexCLI: mocks.codex }));
vi.mock('../../src/utils/claudeExecutor.js', () => ({ executeClaudeCLI: mocks.claude }));

import { askClaudeTool } from '../../src/tools/ask-claude.tool.js';
import { askCodexTool } from '../../src/tools/ask-codex.tool.js';

describe('direct provider effort controls', () => {
  beforeEach(() => {
    mocks.codex.mockReset().mockResolvedValue({ text: 'codex done' });
    mocks.claude.mockReset().mockResolvedValue({ text: 'claude done' });
  });

  it('forwards Luna MAX without creating a workflow', async () => {
    await askCodexTool.execute({
      prompt: 'Implement the assigned specification lane.',
      model: 'gpt-5.6-luna',
      effort: 'max',
      sandbox: 'workspace-write',
    }, { cwd: '/tmp/workspace' });

    expect(mocks.codex).toHaveBeenCalledWith(
      'Implement the assigned specification lane.',
      'gpt-5.6-luna',
      'workspace-write',
      undefined,
      expect.objectContaining({ cwd: '/tmp/workspace' }),
      undefined,
      { effort: 'max' },
    );
  });

  it('forwards Opus MAX through Claude Code effort', async () => {
    await askClaudeTool.execute({
      prompt: 'Review and implement the assigned corrections.',
      model: 'claude-opus-5',
      effort: 'max',
      permissionMode: 'acceptEdits',
    }, { cwd: '/tmp/workspace' });

    expect(mocks.claude).toHaveBeenCalledWith(
      'Review and implement the assigned corrections.',
      'claude-opus-5',
      'acceptEdits',
      undefined,
      undefined,
      expect.objectContaining({ cwd: '/tmp/workspace' }),
      expect.any(String),
      undefined,
      { effort: 'max' },
    );
  });

  it('uses the same explicit default permission mode for new and resumed Claude calls', async () => {
    await askClaudeTool.execute({ prompt: 'Review.', model: 'claude-opus-5' }, { cwd: '/tmp/workspace' });
    expect(mocks.claude.mock.calls[0][2]).toBe('default');
    expect(mocks.claude.mock.calls[0][6]).toEqual(expect.any(String));
  });

  it('rejects an invalid direct effort before provider execution', () => {
    expect(() => askClaudeTool.zodSchema.parse({
      prompt: 'Review.',
      model: 'claude-opus-5',
      effort: 'ultra',
    })).toThrow();
  });
});
