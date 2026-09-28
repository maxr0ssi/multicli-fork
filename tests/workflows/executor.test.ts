import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  codex: vi.fn(),
  claude: vi.fn(),
}));

vi.mock('../../src/utils/codexExecutor.js', () => ({ executeCodexCLI: mocks.codex }));
vi.mock('../../src/utils/claudeExecutor.js', () => ({ executeClaudeCLI: mocks.claude }));

import { LocalSubscriptionCliExecutor } from '../../src/workflows/executor.js';

const sessionId = '11111111-1111-4111-8111-111111111111';

describe('LocalSubscriptionCliExecutor session lifecycle', () => {
  beforeEach(() => {
    mocks.codex.mockReset().mockResolvedValue({ text: 'codex', sessionId });
    mocks.claude.mockReset().mockResolvedValue({ text: 'claude', sessionId });
  });

  it('passes a pinned native session to codex resume', async () => {
    const executor = new LocalSubscriptionCliExecutor({ timeoutMs: 1_000, killGraceMs: 100 });
    await executor.execute({
      profile: {
        profileId: 'sol',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'max',
        workspaceAccess: 'workspace-write',
        selection: 'default',
        enableSubagents: false,
      },
      prompt: 'continue',
      cwd: process.cwd(),
      session: { mode: 'resume', sessionId },
    });

    expect(mocks.codex).toHaveBeenCalledWith(
      'continue',
      'gpt-5.6-sol',
      'workspace-write',
      undefined,
      expect.objectContaining({ cwd: process.cwd() }),
      sessionId,
      { effort: 'max', enableSubagents: false, captureUsage: true },
    );
  });

  it('passes caller-chosen Claude start and resume ids to the correct CLI flags', async () => {
    const executor = new LocalSubscriptionCliExecutor({ timeoutMs: 1_000, killGraceMs: 100 });
    const profile = {
      profileId: 'opus',
      provider: 'claude',
      model: 'claude-opus-5',
      reasoningEffort: 'xhigh',
      workspaceAccess: 'read-only',
      selection: 'explicit-only',
      enableSubagents: false,
    } as const;

    await executor.execute({
      profile,
      prompt: 'start',
      cwd: process.cwd(),
      session: { mode: 'start', sessionId },
    });
    await executor.execute({
      profile,
      prompt: 'resume',
      cwd: process.cwd(),
      session: { mode: 'resume', sessionId },
    });

    expect(mocks.claude.mock.calls[0].slice(6)).toEqual([
      sessionId,
      undefined,
      { effort: 'xhigh', enableSubagents: false, captureUsage: true },
    ]);
    expect(mocks.claude.mock.calls[1].slice(6)).toEqual([
      undefined,
      sessionId,
      { effort: 'xhigh', enableSubagents: false, captureUsage: true },
    ]);
  });

  it('rejects a caller-chosen Codex start id instead of pretending it was honored', async () => {
    const executor = new LocalSubscriptionCliExecutor({ timeoutMs: 1_000, killGraceMs: 100 });
    await expect(executor.execute({
      profile: {
        profileId: 'sol',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        workspaceAccess: 'read-only',
        selection: 'default',
        enableSubagents: false,
      },
      prompt: 'start',
      cwd: process.cwd(),
      session: { mode: 'start', sessionId },
    })).rejects.toThrow(/Codex chooses its native session id/);
    expect(mocks.codex).not.toHaveBeenCalled();
  });
});
