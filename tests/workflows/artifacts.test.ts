import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeWorkflowArtifact } from '../../src/workflows/artifacts.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('workflow artifact writer', () => {
  it('writes a private, no-replace artifact beneath its run directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-artifact-'));
    temporaryDirectories.push(root);
    const destination = writeWorkflowArtifact({
      artifactRoot: root,
      runId: 'run-safe',
      nodeId: 'opus-review',
      attemptNumber: 1,
      text: 'reviewed',
    });

    expect(destination).toBe(path.join(
      fs.realpathSync(root),
      'run-safe',
      'opus-review-1.md',
    ));
    expect(fs.readFileSync(destination, 'utf8')).toBe('reviewed');
    expect(fs.statSync(destination).mode & 0o077).toBe(0);
    expect(() => writeWorkflowArtifact({
      artifactRoot: root,
      runId: 'run-safe',
      nodeId: 'opus-review',
      attemptNumber: 1,
      text: 'overwrite',
    })).toThrow();
  });

  it('rejects a pre-planted run-directory symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-artifact-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-artifact-outside-'));
    temporaryDirectories.push(root, outside);
    fs.symlinkSync(outside, path.join(root, 'run-safe'));

    expect(() => writeWorkflowArtifact({
      artifactRoot: root,
      runId: 'run-safe',
      nodeId: 'opus-review',
      attemptNumber: 1,
      text: 'escape',
    })).toThrow(/symbolic link/i);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
