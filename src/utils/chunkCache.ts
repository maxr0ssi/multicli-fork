import { createHash } from 'crypto';
import { EditChunk } from './changeModeChunker.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface CacheEntry {
  chunks: EditChunk[];
  timestamp: number;
  promptHash: string;
}

const CACHE_DIR = path.join(os.tmpdir(), 'multicli-chunks');
const CACHE_TTL = 10 * 60 * 1000;
const MAX_CACHE_FILES = 50;

// Cache keys are always the first 8 hex chars of a sha256 (see cacheChunks).
// Anything else is rejected: the key is interpolated into a file path that is
// read and, on parse failure, unlinked, so an unvalidated key is an arbitrary
// file deletion primitive via `../` traversal.
const CACHE_KEY_PATTERN = /^[0-9a-f]{8}$/;

function isValidCacheKey(cacheKey: string): boolean {
  return typeof cacheKey === 'string' && CACHE_KEY_PATTERN.test(cacheKey);
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Caches chunks from a changeMode response
 * @param prompt The original prompt (used for hash generation)
 * @param chunks The parsed and chunked edits
 * @returns A short cache key for retrieval
 */
export function cacheChunks(prompt: string, chunks: EditChunk[]): string {
  ensureCacheDir();
  cleanExpiredFiles(); // Cleanup on each write

  // Generate deterministic cache key from prompt
  const promptHash = createHash('sha256').update(prompt).digest('hex');
  const cacheKey = promptHash.slice(0, 8);
  const filePath = path.join(CACHE_DIR, `${cacheKey}.json`);

  // Store with metadata
  const cacheData: CacheEntry = {
    chunks,
    timestamp: Date.now(),
    promptHash
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify(cacheData));
  } catch {
    // cache write failure is non-critical
  }
  enforceFileLimits();
  return cacheKey;
}

/**
 * Retrieves cached chunks if they exist and haven't expired
 * @param cacheKey The cache key returned from cacheChunks
 * @returns The cached chunks or null if expired/not found
 */
export function getChunks(cacheKey: string): EditChunk[] | null {
  if (!isValidCacheKey(cacheKey)) {
    return null;
  }

  const filePath = path.join(CACHE_DIR, `${cacheKey}.json`);

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const data: CacheEntry = JSON.parse(fileContent);

    if (Date.now() - data.timestamp > CACHE_TTL) {
      fs.unlinkSync(filePath);
      return null;
    }

    return data.chunks;
  } catch {
    try {
      fs.unlinkSync(filePath); // Clean up bad file
    } catch {}
    return null;
  }
}

function cleanExpiredFiles(): void {
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CACHE_DIR);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(CACHE_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > CACHE_TTL) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Individual file error - continue with others
      }
    }
  } catch {
    // Non-critical cleanup failure
  }
}


 // maximum file count limit (FIFO) --> LRU?

function enforceFileLimits(): void {
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: path.join(CACHE_DIR, f),
        mtime: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs
      }))
      .sort((a, b) => a.mtime - b.mtime); // Oldest first

    // Remove oldest files if over limit
    if (files.length > MAX_CACHE_FILES) {
      const toRemove = files.slice(0, files.length - MAX_CACHE_FILES);
      for (const file of toRemove) {
        try {
          fs.unlinkSync(file.path);
        } catch {}
      }
    }
  } catch {
    // Non-critical enforcement failure
  }
}

export function getCacheStats(): { size: number; ttl: number; maxSize: number; cacheDir: string } {
  ensureCacheDir();
  let size = 0;

  try {
    const files = fs.readdirSync(CACHE_DIR);
    size = files.filter(f => f.endsWith('.json')).length;
  } catch {}

  return {
    size,
    ttl: CACHE_TTL,
    maxSize: MAX_CACHE_FILES,
    cacheDir: CACHE_DIR
  };
}

export function clearCache(): void { // !
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CACHE_DIR);

    for (const file of files) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(CACHE_DIR, file));
      }
    }
  } catch {
    // cache clear failure is non-critical
  }
}
