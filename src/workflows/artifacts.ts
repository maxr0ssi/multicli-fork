import fs from 'node:fs';
import path from 'node:path';

import {
  requireSafeLocalIdentifier,
  resolveContainedPath,
} from '../utils/safeIdentifier.js';

export function writeWorkflowArtifact(input: {
  artifactRoot: string;
  runId: string;
  nodeId: string;
  attemptNumber: number;
  text: string;
}): string {
  const runId = requireSafeLocalIdentifier(input.runId, 'Run id');
  const nodeId = requireSafeLocalIdentifier(input.nodeId, 'Node id');
  fs.mkdirSync(input.artifactRoot, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(input.artifactRoot);
  const directory = resolveContainedPath(root, runId);
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Workflow artifact directory must not be a symbolic link: ${directory}`);
  }
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const realDirectory = fs.realpathSync(directory);
  resolveContainedPath(root, path.relative(root, realDirectory));

  const destination = resolveContainedPath(
    realDirectory,
    `${nodeId}-${input.attemptNumber}.md`,
  );
  const descriptor = fs.openSync(destination, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, input.text, { encoding: 'utf8' });
  } catch (error) {
    try {
      fs.unlinkSync(destination);
    } catch {
      // Best effort: the ledger will not reference an incomplete artifact.
    }
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(destination, 0o600);
  return destination;
}
