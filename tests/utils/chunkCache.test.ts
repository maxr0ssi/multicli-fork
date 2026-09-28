import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const FAKE_TMPDIR = '/tmp/fake';
const FAKE_CACHE_DIR = path.join(FAKE_TMPDIR, 'multicli-chunks');

// Mock fs and os before importing the module under test.
// os.tmpdir() must return a value immediately because chunkCache.ts
// calls it at module-level to compute CACHE_DIR.
vi.mock('fs');
vi.mock('os', () => ({
  tmpdir: () => '/tmp/fake',
}));

// Now import the module under test
import { cacheChunks, getChunks, clearCache, getCacheStats } from '../../src/utils/chunkCache.js';
import type { EditChunk } from '../../src/utils/changeModeChunker.js';

function makeChunk(index: number, total: number, editCount: number): EditChunk {
  return {
    edits: Array.from({ length: editCount }, (_, i) => ({
      filename: `file${i}.ts`,
      oldStartLine: 1,
      oldEndLine: 5,
      oldCode: 'old code',
      newStartLine: 1,
      newEndLine: 5,
      newCode: 'new code',
    })),
    chunkIndex: index,
    totalChunks: total,
    hasMore: index < total,
    estimatedChars: 500,
  };
}

describe('chunkCache', () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn>;
  let currentTime: number;

  beforeEach(() => {
    vi.clearAllMocks();
    currentTime = 1700000000000;
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(currentTime);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  describe('cacheChunks', () => {
    it('returns an 8-character hex key', () => {
      const chunks = [makeChunk(1, 1, 2)];
      const key = cacheChunks('test prompt', chunks);
      expect(key).toMatch(/^[a-f0-9]{8}$/);
    });

    it('returns deterministic key for the same prompt', () => {
      const chunks = [makeChunk(1, 1, 1)];
      const key1 = cacheChunks('identical prompt', chunks);
      const key2 = cacheChunks('identical prompt', chunks);
      expect(key1).toBe(key2);
    });

    it('returns different keys for different prompts', () => {
      const chunks = [makeChunk(1, 1, 1)];
      const key1 = cacheChunks('prompt alpha', chunks);
      const key2 = cacheChunks('prompt beta', chunks);
      expect(key1).not.toBe(key2);
    });

    it('writes cache file with correct data', () => {
      const chunks = [makeChunk(1, 1, 2)];
      const key = cacheChunks('write test', chunks);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join(FAKE_CACHE_DIR, `${key}.json`),
        expect.any(String)
      );

      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );
      expect(writtenData.chunks).toEqual(chunks);
      expect(writtenData.timestamp).toBe(currentTime);
      expect(writtenData.promptHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('handles write failure gracefully without throwing', () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('disk full');
      });

      const chunks = [makeChunk(1, 1, 1)];
      // Should not throw
      const key = cacheChunks('fail test', chunks);
      expect(key).toMatch(/^[a-f0-9]{8}$/);
    });
  });

  describe('getChunks', () => {
    it('retrieves cached data within TTL', () => {
      const chunks = [makeChunk(1, 2, 3), makeChunk(2, 2, 2)];
      const cacheData = {
        chunks,
        timestamp: currentTime - 5 * 60 * 1000, // 5 minutes ago
        promptHash: 'abcd1234abcd1234',
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cacheData));

      const result = getChunks('abcd1234');
      expect(result).toEqual(chunks);
    });

    it('returns null for expired cache (>10 min TTL)', () => {
      const cacheData = {
        chunks: [makeChunk(1, 1, 1)],
        timestamp: currentTime - 11 * 60 * 1000, // 11 minutes ago (expired)
        promptHash: 'hash',
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cacheData));

      const result = getChunks('expired1');
      expect(result).toBeNull();
    });

    it('deletes expired files on access', () => {
      const cacheData = {
        chunks: [makeChunk(1, 1, 1)],
        timestamp: currentTime - 11 * 60 * 1000,
        promptHash: 'hash',
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cacheData));

      getChunks('e12ed002');
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        path.join(FAKE_CACHE_DIR, 'e12ed002.json')
      );
    });

    it('returns null for nonexistent key', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = getChunks('a0e51571');
      expect(result).toBeNull();
    });

    it('rejects traversal keys without touching the filesystem', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json {{{');

      // An unvalidated key is joined into a path, read, fails to parse, and is
      // then unlinked: an arbitrary file deletion primitive.
      const result = getChunks('../../../../private/tmp/victim');

      expect(result).toBeNull();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('handles corrupted JSON gracefully and cleans up', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json {{{');

      const result = getChunks('c0ffee11');
      expect(result).toBeNull();
      // Should try to clean up the corrupted file
      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });

  describe('clearCache', () => {
    it('removes all JSON files', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([
        'aaa.json', 'bbb.json', 'ccc.json',
      ] as any);

      clearCache();
      expect(fs.unlinkSync).toHaveBeenCalledTimes(3);
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(FAKE_CACHE_DIR, 'aaa.json'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(FAKE_CACHE_DIR, 'bbb.json'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(FAKE_CACHE_DIR, 'ccc.json'));
    });

    it('ignores non-JSON files', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([
        'aaa.json', 'readme.txt', 'data.log',
      ] as any);

      clearCache();
      expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(FAKE_CACHE_DIR, 'aaa.json'));
    });
  });

  describe('getCacheStats', () => {
    it('returns correct size counting only JSON files', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([
        'a.json', 'b.json', 'c.json', 'd.txt', 'e.json',
      ] as any);

      const stats = getCacheStats();
      expect(stats.size).toBe(4); // only .json files
      expect(stats.ttl).toBe(10 * 60 * 1000);
      expect(stats.maxSize).toBe(50);
      expect(stats.cacheDir).toBe(FAKE_CACHE_DIR);
    });
  });
});
