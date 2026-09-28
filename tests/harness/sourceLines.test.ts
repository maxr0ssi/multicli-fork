import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  countPhysicalLines,
  inspectRepositorySourceLines,
} from '../../src/harness/sourceLines.js';

const temporaryDirectories: string[] = [];

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'multicli-source-lines-'));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, 'src'));
  mkdirSync(join(directory, 'scripts'));
  return directory;
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('repository source-line policy', () => {
  it('counts physical lines consistently with or without a trailing newline', () => {
    expect(countPhysicalLines('')).toBe(0);
    expect(countPhysicalLines('one')).toBe(1);
    expect(countPhysicalLines('one\n')).toBe(1);
    expect(countPhysicalLines('one\r\ntwo\r\n')).toBe(2);
  });

  it('allows 399, warns at 400 and 599, and blocks at 600', () => {
    const directory = workspace();
    writeFileSync(join(directory, 'src', 'allowed.ts'), lines(399));
    writeFileSync(join(directory, 'src', 'warning.ts'), lines(400));
    writeFileSync(join(directory, 'scripts', 'warning-too.ts'), lines(599));
    writeFileSync(join(directory, 'scripts', 'blocked.ts'), lines(600));

    const report = inspectRepositorySourceLines(directory);

    expect(report.filesScanned).toBe(4);
    expect(report.warningFindings.map(finding => finding.path)).toEqual([
      'scripts/warning-too.ts',
      'src/warning.ts',
    ]);
    expect(report.blockingFindings.map(finding => finding.path)).toEqual([
      'scripts/blocked.ts',
    ]);
  });

  it('scans authored TypeScript variants but ignores declarations and other files', () => {
    const directory = workspace();
    mkdirSync(join(directory, 'src', 'nested'));
    mkdirSync(join(directory, 'tests'));
    writeFileSync(join(directory, 'src', 'nested', 'source.ts'), lines(400));
    writeFileSync(join(directory, 'tests', 'source.test.ts'), lines(400));
    writeFileSync(join(directory, 'src', 'component.tsx'), lines(400));
    writeFileSync(join(directory, 'scripts', 'task.mts'), lines(400));
    writeFileSync(join(directory, 'src', 'compat.cts'), lines(400));
    writeFileSync(join(directory, 'src', 'types.d.ts'), lines(700));
    writeFileSync(join(directory, 'src', 'generated.js'), lines(700));

    const report = inspectRepositorySourceLines(directory);

    expect(report.filesScanned).toBe(5);
    expect(report.warningFindings.map(finding => finding.path)).toEqual([
      'scripts/task.mts',
      'src/compat.cts',
      'src/component.tsx',
      'src/nested/source.ts',
      'tests/source.test.ts',
    ]);
    expect(report.blockingFindings).toEqual([]);
  });
});
