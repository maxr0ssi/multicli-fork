import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { RunLedger } from '../../persistence/runLedger.js';
import type {
  StudioActionAvailability,
  StudioArtifactPreview,
  StudioArtifactSummary,
} from '../contracts/studio.js';

const DEFAULT_PREVIEW_BYTES = 256 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const PREVIEW_MEDIA_TYPES = new Set([
  'application/json',
  'application/x-ndjson',
  'text/markdown',
  'text/plain',
  'text/x-diff',
  'text/x-patch',
]);

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function unavailable(reason: string): StudioActionAvailability {
  return { allowed: false, reason };
}

export interface StudioArtifactReaderOptions {
  ledger: RunLedger;
  artifactRoot: string;
  previewBytes?: number;
  maxArtifactBytes?: number;
}

/** Reads private run artifacts without exposing or trusting their stored paths. */
export class StudioArtifactReader {
  readonly #root: string;
  readonly #previewBytes: number;
  readonly #maxArtifactBytes: number;

  constructor(private readonly options: StudioArtifactReaderOptions) {
    this.#root = path.resolve(options.artifactRoot);
    this.#previewBytes = options.previewBytes ?? DEFAULT_PREVIEW_BYTES;
    this.#maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(this.#previewBytes) || this.#previewBytes <= 0) {
      throw new Error('Studio artifact previewBytes must be a positive integer');
    }
    if (!Number.isSafeInteger(this.#maxArtifactBytes) || this.#maxArtifactBytes < this.#previewBytes) {
      throw new Error('Studio maxArtifactBytes must be an integer at least previewBytes');
    }
  }

  summarize(runId: string, artifactId: string): StudioArtifactSummary {
    const artifact = this.requireArtifact(runId, artifactId);
    const inspection = this.inspectLocation(artifact.location, artifact.mediaType);
    return {
      id: artifact.id,
      runId: artifact.runId,
      ...(artifact.nodeAttemptId ? { nodeAttemptId: artifact.nodeAttemptId } : {}),
      name: artifact.name,
      mediaType: artifact.mediaType,
      contentHash: artifact.contentHash,
      createdAt: artifact.createdAt,
      ...(inspection.byteLength === undefined ? {} : { byteLength: inspection.byteLength }),
      preview: inspection.availability,
    };
  }

  preview(runId: string, artifactId: string): StudioArtifactPreview {
    const artifact = this.requireArtifact(runId, artifactId);
    const inspection = this.inspectLocation(artifact.location, artifact.mediaType);
    if (!inspection.availability.allowed || !inspection.realPath || inspection.byteLength === undefined) {
      throw new Error(
        inspection.availability.allowed
          ? 'Artifact preview is unavailable'
          : inspection.availability.reason,
      );
    }

    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let descriptor: number;
    try {
      descriptor = fs.openSync(inspection.realPath, fs.constants.O_RDONLY | noFollow);
    } catch {
      throw new Error('Artifact file could not be opened');
    }
    try {
      const current = fs.fstatSync(descriptor);
      if (!current.isFile() || current.size !== inspection.byteLength) {
        throw new Error('Artifact changed while it was being inspected');
      }
      const complete = Buffer.alloc(current.size);
      let offset = 0;
      while (offset < complete.length) {
        const read = fs.readSync(descriptor, complete, offset, complete.length - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      if (offset !== complete.length) throw new Error('Artifact could not be read completely');
      const digest = createHash('sha256').update(complete).digest('hex');
      if (digest !== artifact.contentHash) throw new Error('Artifact integrity check failed');
      const bytesRead = Math.min(complete.length, this.#previewBytes);
      return {
        artifact: this.summarize(runId, artifactId),
        text: complete.subarray(0, bytesRead).toString('utf8'),
        bytesRead,
        totalBytes: complete.length,
        truncated: bytesRead < complete.length,
      };
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private requireArtifact(runId: string, artifactId: string) {
    const artifact = this.options.ledger.getArtifact(artifactId);
    if (!artifact || artifact.runId !== runId) {
      throw new Error(`Unknown artifact: ${artifactId}`);
    }
    return artifact;
  }

  private inspectLocation(location: string, mediaType: string): {
    availability: StudioActionAvailability;
    realPath?: string;
    byteLength?: number;
  } {
    if (!PREVIEW_MEDIA_TYPES.has(mediaType)) {
      return { availability: unavailable(`Preview is not supported for ${mediaType}`) };
    }
    if (!fs.existsSync(this.#root)) {
      return { availability: unavailable('Artifact storage is unavailable') };
    }
    const candidate = path.resolve(location);
    if (!contained(this.#root, candidate)) {
      return { availability: unavailable('Artifact is outside configured storage') };
    }
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(candidate);
    } catch {
      return { availability: unavailable('Artifact file is unavailable') };
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return { availability: unavailable('Artifact is not a regular file') };
    }
    let root: string;
    let realPath: string;
    try {
      root = fs.realpathSync(this.#root);
      realPath = fs.realpathSync(candidate);
    } catch {
      return { availability: unavailable('Artifact file is unavailable') };
    }
    if (!contained(root, realPath)) {
      return { availability: unavailable('Artifact resolves outside configured storage') };
    }
    if (metadata.size > this.#maxArtifactBytes) {
      return { availability: unavailable('Artifact is too large to preview'), byteLength: metadata.size };
    }
    return { availability: { allowed: true }, realPath, byteLength: metadata.size };
  }
}
