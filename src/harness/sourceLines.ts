import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { stableFingerprint } from './fingerprint.js';
import type { HarnessFinding } from './types.js';

export const SOURCE_LINE_WARNING_LIMIT = 400;
export const SOURCE_LINE_BLOCKING_LIMIT = 600;
export const SOURCE_LINE_WARNING_RULE_ID = 'repo.loc.warning';
export const SOURCE_LINE_BLOCKING_RULE_ID = 'repo.loc.blocker';

const SOURCE_ROOTS = ['src', 'scripts', 'tests'] as const;

export interface RepositorySourceLineReport {
  readonly filesScanned: number;
  readonly warningFindings: readonly HarnessFinding[];
  readonly blockingFindings: readonly HarnessFinding[];
}

export type RepositorySourceLineInspector = (
  workspace: string,
) => RepositorySourceLineReport | Promise<RepositorySourceLineReport>;

export function countPhysicalLines(source: string): number {
  if (source.length === 0) return 0;
  const normalized = source.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n').length;
  return normalized.endsWith('\n') ? lines - 1 : lines;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (
      entry.isFile()
      && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)
      && !/\.d\.(?:ts|mts|cts)$/.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function displayPath(workspace: string, path: string): string {
  return relative(workspace, path).split(sep).join('/');
}

function lineFinding(
  ruleId: string,
  path: string,
  lineCount: number,
  limit: number,
  required: boolean,
): HarnessFinding {
  const severity = required ? 'error' : 'warning';
  return Object.freeze({
    ruleId,
    severity,
    path,
    line: limit,
    message: `${path} has ${lineCount} lines; repository policy activates at ${limit}.`,
    repair: 'Split the file into cohesive modules with focused ownership and tests.',
    fingerprint: stableFingerprint(ruleId, { path, lineCount, limit }),
    required,
    waivable: false,
    evidenceRef: `source-lines:${lineCount}`,
  });
}

/** Scans authored TypeScript. Generated output, declarations, and dependencies are excluded. */
export function inspectRepositorySourceLines(workspace: string): RepositorySourceLineReport {
  const files = SOURCE_ROOTS
    .map(root => join(workspace, root))
    .filter(existsSync)
    .flatMap(sourceFiles)
    .sort();
  const warningFindings: HarnessFinding[] = [];
  const blockingFindings: HarnessFinding[] = [];

  for (const file of files) {
    const lineCount = countPhysicalLines(readFileSync(file, 'utf8'));
    const path = displayPath(workspace, file);
    if (lineCount >= SOURCE_LINE_BLOCKING_LIMIT) {
      blockingFindings.push(lineFinding(
        SOURCE_LINE_BLOCKING_RULE_ID,
        path,
        lineCount,
        SOURCE_LINE_BLOCKING_LIMIT,
        true,
      ));
    } else if (lineCount >= SOURCE_LINE_WARNING_LIMIT) {
      warningFindings.push(lineFinding(
        SOURCE_LINE_WARNING_RULE_ID,
        path,
        lineCount,
        SOURCE_LINE_WARNING_LIMIT,
        false,
      ));
    }
  }

  return Object.freeze({
    filesScanned: files.length,
    warningFindings: Object.freeze(warningFindings),
    blockingFindings: Object.freeze(blockingFindings),
  });
}
