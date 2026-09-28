import { describe, it, expect, vi } from 'vitest';
import {
  parseChangeModeOutput,
  validateChangeModeEdits,
  type ChangeModeEdit,
} from '../../src/utils/changeModeParser.js';

// ---------------------------------------------------------------------------
// Helpers to build markdown-format and legacy-format fixture strings
// ---------------------------------------------------------------------------

function markdownBlock(
  filename: string,
  startLine: number,
  oldCode: string,
  newCode: string,
): string {
  return `**FILE: ${filename}:${startLine}**\n\`\`\`\nOLD:\n${oldCode}\nNEW:\n${newCode}\n\`\`\``;
}

function legacyBlock(
  filename: string,
  oldStart: number,
  oldCode: string,
  oldEnd: number,
  newStart: number,
  newCode: string,
  newEnd: number,
  newFilename?: string,
): string {
  const nf = newFilename ?? filename;
  return (
    `/old/ * ${filename} 'start:' ${oldStart}\n` +
    `${oldCode}\n` +
    `// 'end:' ${oldEnd}\n` +
    `\\new\\ * ${nf} 'start:' ${newStart}\n` +
    `${newCode}\n` +
    `// 'end:' ${newEnd}`
  );
}

// ===========================================================================
// parseChangeModeOutput
// ===========================================================================

describe('parseChangeModeOutput', () => {
  // ---- Markdown format tests ----

  it('should parse a single markdown-format edit and verify all fields', () => {
    const input = markdownBlock('src/app.ts', 10, 'const x = 1;', 'const x = 2;');
    const edits = parseChangeModeOutput(input);

    expect(edits).toHaveLength(1);
    const edit = edits[0];
    expect(edit.filename).toBe('src/app.ts');
    expect(edit.oldStartLine).toBe(10);
    expect(edit.oldEndLine).toBe(10); // single line: 10 + 1-1 = 10
    expect(edit.oldCode).toBe('const x = 1;');
    expect(edit.newStartLine).toBe(10);
    expect(edit.newEndLine).toBe(10);
    expect(edit.newCode).toBe('const x = 2;');
  });

  it('should parse multiple markdown edits from one response', () => {
    const input = [
      markdownBlock('src/a.ts', 1, 'aaa', 'bbb'),
      'Some prose between edits.',
      markdownBlock('src/b.ts', 50, 'ccc', 'ddd'),
    ].join('\n\n');

    const edits = parseChangeModeOutput(input);
    expect(edits).toHaveLength(2);
    expect(edits[0].filename).toBe('src/a.ts');
    expect(edits[1].filename).toBe('src/b.ts');
    expect(edits[1].oldStartLine).toBe(50);
  });

  it('should compute oldEndLine correctly for multi-line old code', () => {
    // 5 lines starting at line 10 -> endLine = 10 + 5 - 1 = 14
    const oldCode = 'line1\nline2\nline3\nline4\nline5';
    const input = markdownBlock('file.ts', 10, oldCode, 'replacement');
    const edits = parseChangeModeOutput(input);

    expect(edits).toHaveLength(1);
    expect(edits[0].oldStartLine).toBe(10);
    expect(edits[0].oldEndLine).toBe(14);
  });

  it('should compute newEndLine correctly for multi-line new code', () => {
    // 3 lines starting at line 20 -> endLine = 20 + 3 - 1 = 22
    const newCode = 'alpha\nbeta\ngamma';
    const input = markdownBlock('file.ts', 20, 'old', newCode);
    const edits = parseChangeModeOutput(input);

    expect(edits).toHaveLength(1);
    expect(edits[0].newStartLine).toBe(20);
    expect(edits[0].newEndLine).toBe(22);
  });

  it('should handle empty OLD code (insertion) with oldEndLine equal to startLine', () => {
    const input = markdownBlock('insert.ts', 5, '', 'inserted line');
    const edits = parseChangeModeOutput(input);

    expect(edits).toHaveLength(1);
    expect(edits[0].oldCode).toBe('');
    expect(edits[0].oldStartLine).toBe(5);
    expect(edits[0].oldEndLine).toBe(5); // empty old: startLine + 0
  });

  it('should handle empty NEW code (deletion) with newEndLine equal to startLine', () => {
    const input = markdownBlock('delete.ts', 8, 'removed line', '');
    const edits = parseChangeModeOutput(input);

    expect(edits).toHaveLength(1);
    expect(edits[0].newCode).toBe('');
    expect(edits[0].newStartLine).toBe(8);
    expect(edits[0].newEndLine).toBe(8); // empty new: startLine + 0
  });

  it('should trim trailing whitespace from code blocks', () => {
    const input = markdownBlock('trim.ts', 1, 'code with trailing   \t  ', 'new code   \n  ');
    const edits = parseChangeModeOutput(input);

    expect(edits).toHaveLength(1);
    // trimEnd() removes trailing spaces/tabs/newlines
    expect(edits[0].oldCode).toBe('code with trailing');
    expect(edits[0].newCode).toBe('new code');
  });

  it('should trim whitespace from filenames', () => {
    const input = `**FILE:   src/spaced.ts  :7**\n\`\`\`\nOLD:\nold\nNEW:\nnew\n\`\`\``;
    const edits = parseChangeModeOutput(input);

    expect(edits).toHaveLength(1);
    expect(edits[0].filename).toBe('src/spaced.ts');
  });

  it('should extract edit blocks from mixed prose and edit content', () => {
    const input = [
      'Here is my analysis of the code.\n',
      'I suggest the following changes:\n',
      markdownBlock('src/main.ts', 42, 'old code', 'new code'),
      '\nAdditionally, you should also update:\n',
      markdownBlock('src/helper.ts', 100, 'helper old', 'helper new'),
      '\nThat should fix the issue.',
    ].join('\n');

    const edits = parseChangeModeOutput(input);
    expect(edits).toHaveLength(2);
    expect(edits[0].filename).toBe('src/main.ts');
    expect(edits[0].oldStartLine).toBe(42);
    expect(edits[1].filename).toBe('src/helper.ts');
    expect(edits[1].oldStartLine).toBe(100);
  });

  // ---- Legacy format tests ----

  it('should fall back to legacy format when markdown yields zero edits', () => {
    const input = legacyBlock('src/legacy.ts', 10, 'old code', 15, 10, 'new code', 12);
    const edits = parseChangeModeOutput(input);

    expect(edits).toHaveLength(1);
    expect(edits[0].filename).toBe('src/legacy.ts');
    expect(edits[0].oldStartLine).toBe(10);
    expect(edits[0].oldEndLine).toBe(15);
    expect(edits[0].oldCode).toBe('old code');
    expect(edits[0].newStartLine).toBe(10);
    expect(edits[0].newEndLine).toBe(12);
    expect(edits[0].newCode).toBe('new code');
  });

  it('should skip legacy edits where old and new filenames differ', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const input = legacyBlock('src/a.ts', 1, 'old', 3, 1, 'new', 3, 'src/b.ts');
    const edits = parseChangeModeOutput(input);

    expect(edits).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Filename mismatch'),
    );

    warnSpy.mockRestore();
  });

  it('should not use legacy format if markdown format already matched', () => {
    // Build input that has BOTH a markdown block AND a legacy block.
    // The legacy block should be ignored because markdown already found edits.
    const md = markdownBlock('src/md.ts', 1, 'md old', 'md new');
    const legacy = legacyBlock('src/leg.ts', 1, 'leg old', 5, 1, 'leg new', 3);
    const input = md + '\n\n' + legacy;

    const edits = parseChangeModeOutput(input);
    // Only the markdown edit should appear.
    expect(edits).toHaveLength(1);
    expect(edits[0].filename).toBe('src/md.ts');
  });

  // ---- Unrecognized format ----

  it('should return an empty array for unrecognized format', () => {
    const input = 'This is just plain text with no edits at all.';
    const edits = parseChangeModeOutput(input);
    expect(edits).toHaveLength(0);
  });

  it('should return an empty array for an empty string', () => {
    expect(parseChangeModeOutput('')).toHaveLength(0);
  });
});

// ===========================================================================
// validateChangeModeEdits
// ===========================================================================

describe('validateChangeModeEdits', () => {
  it('should return valid:true and empty errors for valid edits', () => {
    const edits: ChangeModeEdit[] = [
      {
        filename: 'src/app.ts',
        oldStartLine: 1,
        oldEndLine: 5,
        oldCode: 'old',
        newStartLine: 1,
        newEndLine: 3,
        newCode: 'new',
      },
    ];

    const result = validateChangeModeEdits(edits);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect missing filename', () => {
    const edits: ChangeModeEdit[] = [
      {
        filename: '',
        oldStartLine: 1,
        oldEndLine: 1,
        oldCode: 'x',
        newStartLine: 1,
        newEndLine: 1,
        newCode: 'y',
      },
    ];

    const result = validateChangeModeEdits(edits);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Edit missing filename');
  });

  it('should detect inverted old line range (start > end)', () => {
    const edits: ChangeModeEdit[] = [
      {
        filename: 'test.ts',
        oldStartLine: 10,
        oldEndLine: 5,
        oldCode: 'old',
        newStartLine: 1,
        newEndLine: 1,
        newCode: 'new',
      },
    ];

    const result = validateChangeModeEdits(edits);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Invalid line range for test.ts: 10 > 5'),
      ]),
    );
  });

  it('should detect inverted new line range (start > end)', () => {
    const edits: ChangeModeEdit[] = [
      {
        filename: 'test.ts',
        oldStartLine: 1,
        oldEndLine: 1,
        oldCode: 'old',
        newStartLine: 20,
        newEndLine: 10,
        newCode: 'new',
      },
    ];

    const result = validateChangeModeEdits(edits);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Invalid new line range for test.ts: 20 > 10'),
      ]),
    );
  });

  it('should detect empty edit (both old and new code empty)', () => {
    const edits: ChangeModeEdit[] = [
      {
        filename: 'empty.ts',
        oldStartLine: 1,
        oldEndLine: 1,
        oldCode: '',
        newStartLine: 1,
        newEndLine: 1,
        newCode: '',
      },
    ];

    const result = validateChangeModeEdits(edits);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Empty edit for empty.ts')]),
    );
  });

  it('should allow deletion-only edit (old has content, new is empty)', () => {
    const edits: ChangeModeEdit[] = [
      {
        filename: 'del.ts',
        oldStartLine: 1,
        oldEndLine: 3,
        oldCode: 'to be deleted',
        newStartLine: 1,
        newEndLine: 1,
        newCode: '',
      },
    ];

    const result = validateChangeModeEdits(edits);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should allow insertion-only edit (old is empty, new has content)', () => {
    const edits: ChangeModeEdit[] = [
      {
        filename: 'ins.ts',
        oldStartLine: 5,
        oldEndLine: 5,
        oldCode: '',
        newStartLine: 5,
        newEndLine: 7,
        newCode: 'inserted code',
      },
    ];

    const result = validateChangeModeEdits(edits);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should collect multiple errors from multiple bad edits', () => {
    const edits: ChangeModeEdit[] = [
      {
        filename: '',
        oldStartLine: 10,
        oldEndLine: 5,
        oldCode: '',
        newStartLine: 1,
        newEndLine: 1,
        newCode: '',
      },
      {
        filename: 'another.ts',
        oldStartLine: 1,
        oldEndLine: 1,
        oldCode: '',
        newStartLine: 20,
        newEndLine: 10,
        newCode: '',
      },
    ];

    const result = validateChangeModeEdits(edits);
    expect(result.valid).toBe(false);
    // First edit: missing filename + inverted old range + empty edit = 3 errors
    // Second edit: inverted new range + empty edit = 2 errors
    expect(result.errors.length).toBeGreaterThanOrEqual(5);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        'Edit missing filename',
        expect.stringContaining('Invalid line range'),
        expect.stringContaining('Invalid new line range'),
        expect.stringContaining('Empty edit'),
      ]),
    );
  });

  it('should return valid:true for an empty edits array', () => {
    const result = validateChangeModeEdits([]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
