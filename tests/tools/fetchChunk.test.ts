import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/utils/chunkCache.js', () => ({ getChunks: vi.fn() }));
import { getChunks } from '../../src/utils/chunkCache.js';
import { fetchAntigravityChunkTool, fetchChunkTool } from '../../src/tools/fetch-chunk.tool.js';

describe('fetch chunk tools', () => {
  it.each([fetchAntigravityChunkTool, fetchChunkTool])('explains unavailable cached chunks for $name', async tool => {
    vi.mocked(getChunks).mockReturnValue(null);
    const result = await tool.execute({ cacheKey: '12345678', chunkIndex: 1 });
    expect(result).toContain('10-minute TTL');
    expect(result).toContain('Re-run the original changeMode request');
    expect(result).not.toContain('restarted');
  });

  it('reports the available range for an invalid chunk index', async () => {
    vi.mocked(getChunks).mockReturnValue([{ edits: [], chunkIndex: 1, totalChunks: 1, hasMore: false, estimatedChars: 0 }]);
    const result = await fetchAntigravityChunkTool.execute({ cacheKey: '12345678', chunkIndex: 2 });
    expect(result).toBe('Invalid chunk index: 2. Available chunks: 1 to 1.');
  });

  it.each([
    fetchAntigravityChunkTool,
    fetchChunkTool,
  ])('documents cacheKey and chunkIndex prompt arguments for %s', (tool) => {
    expect(tool.prompt?.arguments).toEqual([
      {
        name: 'cacheKey',
        description: 'The cache key provided in the initial changeMode response',
        required: true,
      },
      {
        name: 'chunkIndex',
        description: 'Which chunk to retrieve (1-based index)',
        required: true,
      },
    ]);
  });
});
