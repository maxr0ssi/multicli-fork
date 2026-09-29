import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/antigravityExecutor.js', () => ({
  executeAntigravityCLI: vi.fn(),
  processChangeModeOutput: vi.fn(),
}));

import { askAntigravityTool } from '../../src/tools/ask-antigravity.tool.js';
import { executeAntigravityCLI, processChangeModeOutput } from '../../src/utils/antigravityExecutor.js';

describe('Ask-Antigravity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(executeAntigravityCLI).mockResolvedValue('provider response');
    vi.mocked(processChangeModeOutput).mockResolvedValue('formatted edits');
  });

  it('forwards a direct request to the Antigravity executor', async () => {
    const context = { cwd: '/workspace' };
    const result = await askAntigravityTool.execute({ prompt: 'Review @src/index.ts', model: 'test-model' }, context);
    expect(executeAntigravityCLI).toHaveBeenCalledWith('Review @src/index.ts', 'test-model', false, false, context);
    expect(result).toContain('provider response');
    expect(processChangeModeOutput).not.toHaveBeenCalled();
  });

  it('formats changeMode output and preserves the prompt for caching', async () => {
    const result = await askAntigravityTool.execute({ prompt: 'Fix @src/index.ts', model: 'test-model', changeMode: true });
    expect(executeAntigravityCLI).toHaveBeenCalledWith('Fix @src/index.ts', 'test-model', false, true, undefined);
    expect(processChangeModeOutput).toHaveBeenCalledWith('provider response', undefined, undefined, 'Fix @src/index.ts');
    expect(result).toBe('formatted edits');
  });

  it('retrieves a cached chunk without another provider call', async () => {
    await askAntigravityTool.execute({
      prompt: 'Fix @src/index.ts', model: 'test-model', changeMode: true,
      chunkIndex: 2, chunkCacheKey: 'cache-key',
    });
    expect(executeAntigravityCLI).not.toHaveBeenCalled();
    expect(processChangeModeOutput).toHaveBeenCalledWith('', 2, 'cache-key', 'Fix @src/index.ts');
  });
});
