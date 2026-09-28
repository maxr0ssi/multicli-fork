import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/commandExecutor.js', () => ({
  executeCommand: vi.fn().mockResolvedValue('mock response'),
}));

import { executeClaudeCLI } from '../../src/utils/claudeExecutor.js';
import { executeCommand } from '../../src/utils/commandExecutor.js';

describe('claudeExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds correct base args', async () => {
    await executeClaudeCLI('explain this code', 'claude-sonnet-5');

    expect(executeCommand).toHaveBeenCalledWith(
      'claude',
      [
        '--print',
        '--output-format', 'text',
        '--model', 'claude-sonnet-5',
        'explain this code',
      ],
      expect.objectContaining({ env: expect.any(Object) })
    );
  });

  it('adds --permission-mode when provided', async () => {
    await executeClaudeCLI('task', 'claude-sonnet-5', 'bypassPermissions');

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
  });

  it('adds --max-budget-usd when provided', async () => {
    await executeClaudeCLI('task', 'claude-sonnet-5', undefined, 5.0);

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('5');
  });

  it('adds --system-prompt when provided', async () => {
    await executeClaudeCLI('task', 'claude-sonnet-5', undefined, undefined, 'Be concise');

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args).toContain('--system-prompt');
    expect(args).toContain('Be concise');
  });

  it('passes onProgress callback through', async () => {
    const onProgress = vi.fn();
    await executeClaudeCLI('task', 'claude-sonnet-5', undefined, undefined, undefined, { onProgress });

    expect(executeCommand).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({ onProgress, env: expect.any(Object) })
    );
  });

  it('actively disables provider-native subagents when a workflow opts out', async () => {
    await executeClaudeCLI(
      'review',
      'claude-opus-5',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { enableSubagents: false },
    );

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('Agent,Task');
  });

  it('forwards the selected Claude thinking level as CLI effort', async () => {
    await executeClaudeCLI(
      'review',
      'claude-sonnet-5',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { effort: 'xhigh' },
    );

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh');
  });

  it('requests and parses structured usage only when workflow capture is enabled', async () => {
    vi.mocked(executeCommand).mockResolvedValueOnce(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0.01,
      usage: { input_tokens: 20, output_tokens: 4 },
    }));

    const result = await executeClaudeCLI(
      'review', 'claude-opus-5', undefined, undefined, undefined,
      undefined, undefined, undefined, { captureUsage: true },
    );

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2))
      .toEqual(['--output-format', 'json']);
    expect(result).toMatchObject({
      text: 'done',
      usage: { inputTokens: 20, outputTokens: 4, estimatedCostUsd: 0.01 },
    });
  });
});
