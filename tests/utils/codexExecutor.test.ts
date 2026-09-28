import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/commandExecutor.js', () => ({
  executeCommand: vi.fn().mockResolvedValue('mock response'),
}));

import { executeCodexCLI } from '../../src/utils/codexExecutor.js';
import { executeCommand } from '../../src/utils/commandExecutor.js';

describe('codexExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds correct base args, defaulting the sandbox to read-only', async () => {
    await executeCodexCLI('fix this bug', 'gpt-5.2-codex');

    // --full-auto forces a writable workspace and beats a later -s read-only,
    // so it must be absent unless a write sandbox was explicitly requested.
    expect(executeCommand).toHaveBeenCalledWith(
      'codex',
      [
        'exec', 'fix this bug',
        '--skip-git-repo-check',
        '--color', 'never',
        '-m', 'gpt-5.2-codex',
        '-s', 'read-only',
      ],
      expect.objectContaining({ env: expect.any(Object) }),
      expect.any(Function)
    );
  });

  it('adds -s sandbox when provided', async () => {
    await executeCodexCLI('task', 'gpt-5.2-codex', 'read-only');

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args).toContain('-s');
    expect(args).toContain('read-only');
  });

  it('lets an explicit sandbox override the read-only default', async () => {
    await executeCodexCLI('task', 'gpt-5.2-codex', 'workspace-write');

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args).toContain('workspace-write');
    expect(args).not.toContain('read-only');
  });

  it('never forwards -a approvalPolicy: codex exec rejects the flag', async () => {
    await executeCodexCLI('task', 'gpt-5.2-codex', undefined, 'never');

    // `codex exec` (CLI 0.145.0+) errors out on -a/--approval. Forwarding it
    // fails the whole call, so approvalPolicy is deliberately dropped.
    // Note: 'never' still appears as the value of `--color never`.
    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args).not.toContain('-a');
    expect(args).not.toContain('--approval');
  });

  it('forwards sandbox but still drops approvalPolicy when both provided', async () => {
    await executeCodexCLI('task', 'gpt-5.2-codex', 'workspace-write', 'on-failure');

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args).toContain('-s');
    expect(args).toContain('workspace-write');
    expect(args).not.toContain('-a');
    expect(args).not.toContain('on-failure');
  });

  it('passes onProgress callback through', async () => {
    const onProgress = vi.fn();
    await executeCodexCLI('task', 'gpt-5.2-codex', undefined, undefined, { onProgress });

    expect(executeCommand).toHaveBeenCalledWith(
      'codex',
      expect.any(Array),
      expect.objectContaining({ onProgress, env: expect.any(Object) }),
      expect.any(Function)
    );
  });

  it('actively disables provider-native subagents when a workflow opts out', async () => {
    await executeCodexCLI(
      'review',
      'gpt-5.6-sol',
      undefined,
      undefined,
      undefined,
      undefined,
      { enableSubagents: false },
    );

    expect(vi.mocked(executeCommand).mock.calls[0][1].slice(0, 6)).toEqual([
      'exec',
      '--disable',
      'multi_agent',
      '--disable',
      'multi_agent_v2',
      'review',
    ]);
  });

  it('requests and parses structured usage only when workflow capture is enabled', async () => {
    vi.mocked(executeCommand).mockResolvedValueOnce([
      JSON.stringify({ type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 4 },
      }),
    ].join('\n'));

    const result = await executeCodexCLI(
      'review', 'gpt-5.6-sol', undefined, undefined, undefined, undefined,
      { captureUsage: true },
    );

    expect(vi.mocked(executeCommand).mock.calls[0][1]).toContain('--json');
    expect(result).toMatchObject({
      text: 'done',
      usage: { inputTokens: 20, cachedInputTokens: 10, outputTokens: 4 },
    });
  });
});

describe('codexExecutor resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses `exec resume` with the config-override sandbox, not -s', async () => {
    await executeCodexCLI('turn 2', 'gpt-5.2-codex', undefined, undefined, undefined,
      '019fd6c2-c155-7ed0-937d-4cbe925c0ee8');

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args.slice(0, 4)).toEqual([
      'exec', 'resume', '019fd6c2-c155-7ed0-937d-4cbe925c0ee8', 'turn 2',
    ]);
    // `codex exec resume` rejects -s/--sandbox and --color outright.
    expect(args).toContain('-c');
    expect(args).toContain('sandbox_mode=read-only');
    expect(args).not.toContain('-s');
    expect(args).not.toContain('--color');
  });

  it('never sends flags that would silently break the conversation guarantee', async () => {
    await executeCodexCLI('turn 2', 'gpt-5.2-codex', 'workspace-write', undefined, undefined,
      '019fd6c2-c155-7ed0-937d-4cbe925c0ee8');

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    // --ephemeral writes no rollout, ending the conversation silently.
    expect(args).not.toContain('--ephemeral');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    // --full-auto is not a valid resume flag and must never reappear here.
    expect(args).not.toContain('--full-auto');
  });

  it('refuses a non-UUID session id rather than starting a new paid session', async () => {
    await expect(
      executeCodexCLI('turn 2', 'gpt-5.2-codex', undefined, undefined, undefined, 'not-a-uuid'),
    ).rejects.toThrow(/non-UUID/);

    expect(executeCommand).not.toHaveBeenCalled();
  });
});
