import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createInMemoryRunLedger } from '../../../src/persistence/runLedger.js';
import { StudioArtifactReader } from '../../../src/studio/server/artifactReader.js';
import { createLunaBuildCouncilDefinition } from '../../../src/workflows/lunaBuildCouncil.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-artifact-reader-'));
  temporaryDirectories.push(directory);
  const root = path.join(directory, 'artifacts');
  fs.mkdirSync(root);
  const ledger = createInMemoryRunLedger();
  const revision = ledger.recordWorkflowRevision({
    workflowId: 'reader',
    definition: createLunaBuildCouncilDefinition({ builderCount: 2 }),
  });
  const run = ledger.createStartedRun({
    workflowRevisionId: revision.id, workspace: process.cwd(),
  }).run;
  const reader = new StudioArtifactReader({
    ledger,
    artifactRoot: root,
    previewBytes: 8,
    maxArtifactBytes: 64,
  });
  return { directory, ledger, reader, root, run };
}

describe('StudioArtifactReader', () => {
  it('rejects outside-root and symlink artifact locations', () => {
    const { directory, ledger, reader, root, run } = setup();
    const outside = path.join(directory, 'outside.md');
    fs.writeFileSync(outside, 'outside');
    const outsideArtifact = ledger.recordArtifact({
      runId: run.id,
      contentHash: createHash('sha256').update('outside').digest('hex'),
      mediaType: 'text/markdown',
      name: 'Outside',
      location: outside,
    });
    const link = path.join(root, 'linked.md');
    fs.symlinkSync(outside, link);
    const linkedArtifact = ledger.recordArtifact({
      runId: run.id,
      contentHash: outsideArtifact.contentHash,
      mediaType: 'text/markdown',
      name: 'Linked',
      location: link,
    });

    expect(reader.summarize(run.id, outsideArtifact.id).preview).toEqual({
      allowed: false,
      reason: 'Artifact is outside configured storage',
    });
    expect(reader.summarize(run.id, linkedArtifact.id).preview).toEqual({
      allowed: false,
      reason: 'Artifact is not a regular file',
    });
    expect(() => reader.preview(run.id, linkedArtifact.id)).toThrow(/not a regular file/);
    ledger.close();
  });

  it('enforces stable run ownership, preview truncation, size, and media limits', () => {
    const { ledger, reader, root, run } = setup();
    const location = path.join(root, 'small.txt');
    fs.writeFileSync(location, '0123456789');
    const artifact = ledger.recordArtifact({
      runId: run.id,
      contentHash: createHash('sha256').update('0123456789').digest('hex'),
      mediaType: 'text/plain',
      name: 'Small',
      location,
    });
    expect(reader.preview(run.id, artifact.id)).toMatchObject({
      text: '01234567', bytesRead: 8, totalBytes: 10, truncated: true,
    });
    expect(() => reader.preview('different-run', artifact.id)).toThrow(/Unknown artifact/);

    const binary = ledger.recordArtifact({
      runId: run.id,
      contentHash: artifact.contentHash,
      mediaType: 'application/octet-stream',
      name: 'Binary',
      location,
    });
    expect(reader.summarize(run.id, binary.id).preview).toMatchObject({ allowed: false });

    const largeLocation = path.join(root, 'large.txt');
    fs.writeFileSync(largeLocation, 'x'.repeat(65));
    const large = ledger.recordArtifact({
      runId: run.id,
      contentHash: createHash('sha256').update('x'.repeat(65)).digest('hex'),
      mediaType: 'text/plain',
      name: 'Large',
      location: largeLocation,
    });
    expect(reader.summarize(run.id, large.id).preview).toEqual({
      allowed: false,
      reason: 'Artifact is too large to preview',
    });
    ledger.close();
  });
});
