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
    await executeClaudeCLI('explain this code', 'claude-sonnet-4-6');

    expect(executeCommand).toHaveBeenCalledWith(
      'claude',
      [
        '--print',
        '--output-format', 'text',
        '--model', 'claude-sonnet-4-6',
        'explain this code',
      ],
      expect.objectContaining({ env: expect.any(Object) })
    );
  });

  it('adds --permission-mode when provided', async () => {
    await executeClaudeCLI('task', 'claude-sonnet-4-6', 'bypassPermissions');

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
  });

  it('adds --max-budget-usd when provided', async () => {
    await executeClaudeCLI('task', 'claude-sonnet-4-6', undefined, 5.0);

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('5');
  });

  it('adds --system-prompt when provided', async () => {
    await executeClaudeCLI('task', 'claude-sonnet-4-6', undefined, undefined, 'Be concise');

    const args = vi.mocked(executeCommand).mock.calls[0][1];
    expect(args).toContain('--system-prompt');
    expect(args).toContain('Be concise');
  });

  it('passes onProgress callback through', async () => {
    const onProgress = vi.fn();
    await executeClaudeCLI('task', 'claude-sonnet-4-6', undefined, undefined, undefined, { onProgress });

    expect(executeCommand).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({ onProgress, env: expect.any(Object) })
    );
  });
});
