import { ChangeModeEdit } from '../../src/utils/changeModeParser.js';
import {
  chunkChangeModeEdits,
  summarizeChunking,
  EditChunk,
} from '../../src/utils/changeModeChunker.js';

/**
 * Helper: creates a ChangeModeEdit with sensible defaults so tests can
 * focus on filename / oldCode / newCode without filling in every field.
 */
function makeEdit(
  filename: string,
  oldCode: string,
  newCode: string,
): ChangeModeEdit {
  return {
    filename,
    oldStartLine: 1,
    oldEndLine: 1 + (oldCode === '' ? 0 : oldCode.split('\n').length - 1),
    oldCode,
    newStartLine: 1,
    newEndLine: 1 + (newCode === '' ? 0 : newCode.split('\n').length - 1),
    newCode,
  };
}

/**
 * Mirror of the private estimateEditSize so we can build exact
 * thresholds in tests without hard-coding magic numbers.
 */
function estimateEditSize(edit: ChangeModeEdit): number {
  const jsonOverhead = 250;
  const contentSize =
    edit.filename.length * 2 + edit.oldCode.length + edit.newCode.length;
  return jsonOverhead + contentSize;
}

// ---------------------------------------------------------------------------
// chunkChangeModeEdits
// ---------------------------------------------------------------------------
describe('chunkChangeModeEdits', () => {
  // 1. Empty input returns single empty chunk with correct metadata
  it('returns a single empty chunk when given no edits', () => {
    const result = chunkChangeModeEdits([]);

    expect(result).toHaveLength(1);
    const chunk = result[0];
    expect(chunk.edits).toEqual([]);
    expect(chunk.chunkIndex).toBe(1);
    expect(chunk.totalChunks).toBe(1);
    expect(chunk.hasMore).toBe(false);
    expect(chunk.estimatedChars).toBe(0);
  });

  // 2. Small edits stay in one chunk
  it('keeps small edits together in a single chunk', () => {
    const edits = [
      makeEdit('a.ts', 'old1', 'new1'),
      makeEdit('b.ts', 'old2', 'new2'),
    ];

    const result = chunkChangeModeEdits(edits, 100_000);

    expect(result).toHaveLength(1);
    expect(result[0].edits).toHaveLength(2);
    expect(result[0].hasMore).toBe(false);
    expect(result[0].chunkIndex).toBe(1);
    expect(result[0].totalChunks).toBe(1);
  });

  // 3. Large edits split across multiple chunks respecting maxCharsPerChunk
  it('splits edits across chunks when they exceed maxCharsPerChunk', () => {
    const editA = makeEdit('a.ts', 'x'.repeat(500), 'y'.repeat(500));
    const editB = makeEdit('b.ts', 'x'.repeat(500), 'y'.repeat(500));
    const editC = makeEdit('c.ts', 'x'.repeat(500), 'y'.repeat(500));

    // Each edit is roughly 250 + 3*2 + 500 + 500 = 1256 chars.
    // A limit of 1300 forces one edit per chunk.
    const result = chunkChangeModeEdits([editA, editB, editC], 1300);

    expect(result.length).toBeGreaterThanOrEqual(2);
    // Every chunk's estimated chars should be at or below the limit
    // (the only exception is a single edit that by itself exceeds the limit,
    //  which is not the case here).
    for (const chunk of result) {
      expect(chunk.estimatedChars).toBeLessThanOrEqual(1300);
    }
  });

  // 4. Edits grouped by filename (same file's edits are adjacent)
  it('groups edits by filename so the same file appears in contiguous edits', () => {
    const edits = [
      makeEdit('a.ts', 'a1', 'a2'),
      makeEdit('b.ts', 'b1', 'b2'),
      makeEdit('a.ts', 'a3', 'a4'),
    ];

    const result = chunkChangeModeEdits(edits, 100_000);

    // All in one chunk because they are small.
    expect(result).toHaveLength(1);
    const filenames = result[0].edits.map((e) => e.filename);
    // The two 'a.ts' edits should be adjacent (grouped), then 'b.ts'.
    expect(filenames).toEqual(['a.ts', 'a.ts', 'b.ts']);
  });

  // 5. Single file's edits kept together when possible
  it('keeps all edits for one file in the same chunk when they fit', () => {
    const edits = [
      makeEdit('same.ts', 'o1', 'n1'),
      makeEdit('same.ts', 'o2', 'n2'),
      makeEdit('same.ts', 'o3', 'n3'),
    ];

    const singleEditSize = estimateEditSize(edits[0]);
    // Set limit well above the total for the three edits.
    const result = chunkChangeModeEdits(edits, singleEditSize * 5);

    expect(result).toHaveLength(1);
    expect(result[0].edits).toHaveLength(3);
    expect(result[0].edits.every((e) => e.filename === 'same.ts')).toBe(true);
  });

  // 6. Oversized single file splits individual edits across chunks
  it('splits individual edits of an oversized file across chunks', () => {
    // Create three edits for the SAME file, each large enough that two
    // cannot fit within one chunk.
    const bigOld = 'x'.repeat(800);
    const bigNew = 'y'.repeat(800);
    const edits = [
      makeEdit('big.ts', bigOld, bigNew),
      makeEdit('big.ts', bigOld, bigNew),
      makeEdit('big.ts', bigOld, bigNew),
    ];

    const oneEditSize = estimateEditSize(edits[0]);
    // Limit allows exactly one edit per chunk (just over one edit size,
    // but under two).
    const limit = oneEditSize + 10;

    const result = chunkChangeModeEdits(edits, limit);

    expect(result).toHaveLength(3);
    for (const chunk of result) {
      expect(chunk.edits).toHaveLength(1);
    }
  });

  // 7. hasMore is true for all chunks except the last
  it('sets hasMore=true on every chunk except the last', () => {
    const edits = [
      makeEdit('a.ts', 'x'.repeat(500), 'y'.repeat(500)),
      makeEdit('b.ts', 'x'.repeat(500), 'y'.repeat(500)),
      makeEdit('c.ts', 'x'.repeat(500), 'y'.repeat(500)),
    ];

    const oneEditSize = estimateEditSize(edits[0]);
    const result = chunkChangeModeEdits(edits, oneEditSize + 1);

    expect(result.length).toBeGreaterThan(1);

    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].hasMore).toBe(true);
    }
    expect(result[result.length - 1].hasMore).toBe(false);
  });

  // 8. chunkIndex is 1-based sequential
  it('assigns 1-based sequential chunkIndex values', () => {
    const edits = [
      makeEdit('a.ts', 'x'.repeat(500), 'y'.repeat(500)),
      makeEdit('b.ts', 'x'.repeat(500), 'y'.repeat(500)),
      makeEdit('c.ts', 'x'.repeat(500), 'y'.repeat(500)),
    ];

    const oneEditSize = estimateEditSize(edits[0]);
    const result = chunkChangeModeEdits(edits, oneEditSize + 1);

    expect(result.length).toBeGreaterThan(1);
    for (let i = 0; i < result.length; i++) {
      expect(result[i].chunkIndex).toBe(i + 1);
    }
  });

  // 9. totalChunks consistent across all chunks
  it('sets totalChunks to the same value across every chunk', () => {
    const edits = [
      makeEdit('a.ts', 'x'.repeat(500), 'y'.repeat(500)),
      makeEdit('b.ts', 'x'.repeat(500), 'y'.repeat(500)),
      makeEdit('c.ts', 'x'.repeat(500), 'y'.repeat(500)),
      makeEdit('d.ts', 'x'.repeat(500), 'y'.repeat(500)),
    ];

    const oneEditSize = estimateEditSize(edits[0]);
    const result = chunkChangeModeEdits(edits, oneEditSize + 1);

    const expectedTotal = result.length;
    expect(expectedTotal).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.totalChunks).toBe(expectedTotal);
    }
  });

  // 10. Custom maxCharsPerChunk is respected
  it('respects a custom maxCharsPerChunk value', () => {
    // Build edits where each is ~260 chars (250 overhead + small content).
    const edits = Array.from({ length: 10 }, (_, i) =>
      makeEdit(`f${i}.ts`, 'o', 'n'),
    );

    const singleSize = estimateEditSize(edits[0]);

    // Allow exactly 3 edits per chunk.
    const limit = singleSize * 3;
    const result = chunkChangeModeEdits(edits, limit);

    // We should get at least ceil(10/3) = 4 chunks.
    expect(result.length).toBeGreaterThanOrEqual(4);

    // No chunk should exceed the limit.
    for (const chunk of result) {
      expect(chunk.estimatedChars).toBeLessThanOrEqual(limit);
    }

    // Total edits across all chunks should equal the original count.
    const totalEdits = result.reduce((sum, c) => sum + c.edits.length, 0);
    expect(totalEdits).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// summarizeChunking
// ---------------------------------------------------------------------------
describe('summarizeChunking', () => {
  // 11. Produces accurate summary stats
  it('produces accurate summary statistics for multiple chunks', () => {
    const editsA = [makeEdit('a.ts', 'old', 'new')];
    const editsB = [
      makeEdit('b.ts', 'old1', 'new1'),
      makeEdit('b.ts', 'old2', 'new2'),
    ];

    const chunks: EditChunk[] = [
      {
        edits: editsA,
        chunkIndex: 1,
        totalChunks: 2,
        hasMore: true,
        estimatedChars: 400,
      },
      {
        edits: editsB,
        chunkIndex: 2,
        totalChunks: 2,
        hasMore: false,
        estimatedChars: 800,
      },
    ];

    const summary = summarizeChunking(chunks);

    // Total edits = 1 + 2 = 3
    expect(summary).toContain('# edits: 3');
    // Total chunks = 2
    expect(summary).toContain('# chunks: 2');
    // Total chars = 400 + 800 = 1200
    expect(summary).toContain('est chars: 1,200');
    // Mean size = round(1200 / 2) = 600
    expect(summary).toContain('mean size: 600 chars');
    // Individual chunk lines
    expect(summary).toContain('Chunk 1: 1 edits, ~400 chars');
    expect(summary).toContain('Chunk 2: 2 edits, ~800 chars');
  });

  // 12. Handles single chunk
  it('handles a single chunk correctly', () => {
    const edits = [makeEdit('only.ts', 'old', 'new')];
    const chunks: EditChunk[] = [
      {
        edits,
        chunkIndex: 1,
        totalChunks: 1,
        hasMore: false,
        estimatedChars: 500,
      },
    ];

    const summary = summarizeChunking(chunks);

    expect(summary).toContain('# edits: 1');
    expect(summary).toContain('# chunks: 1');
    expect(summary).toContain('est chars: 500');
    expect(summary).toContain('mean size: 500 chars');
    expect(summary).toContain('Chunk 1: 1 edits, ~500 chars');
    // Header present
    expect(summary).toMatch(/^Chunking Summary:/);
  });
});
