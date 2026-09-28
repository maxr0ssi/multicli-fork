import { useEffect, useState } from 'preact/hooks';

import type { StudioApi } from '../../api.js';
import { formatBytes, formatTime } from '../../format.js';
import type {
  StudioArtifactPreview,
  StudioArtifactSummary,
} from '../../types.js';
import { useModalDialog } from '../../useModalDialog.js';

function ArtifactPreviewDialog({
  artifact,
  preview,
  error,
  onClose,
}: {
  readonly artifact: StudioArtifactSummary;
  readonly preview?: StudioArtifactPreview;
  readonly error?: string;
  readonly onClose: () => void;
}) {
  const dialog = useModalDialog();
  return (
    <dialog ref={dialog} class="preview-dialog" aria-labelledby="preview-title" onClose={onClose}>
      <div class="dialog-heading">
        <div><p class="context-label">{artifact.mediaType}</p><h2 id="preview-title">{artifact.name}</h2></div>
        <button class="button" type="button" onClick={() => dialog.current?.close()}>Close</button>
      </div>
      {error && <p class="notice notice-danger" role="alert">{error}</p>}
      {!error && !preview && <p aria-live="polite">Loading preview…</p>}
      {preview && (
        <>
          {preview.truncated && (
            <p class="notice">Showing {formatBytes(preview.bytesRead)} of {formatBytes(preview.totalBytes)}.</p>
          )}
          <pre class="artifact-preview">{preview.text}</pre>
        </>
      )}
    </dialog>
  );
}

interface ArtifactListProps {
  readonly runId: string;
  readonly artifacts: readonly StudioArtifactSummary[];
  readonly api: StudioApi;
}

export function ArtifactList({ runId, artifacts, api }: ArtifactListProps) {
  const [selected, setSelected] = useState<StudioArtifactSummary>();
  const [preview, setPreview] = useState<StudioArtifactPreview>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setSelected(undefined);
    setPreview(undefined);
    setError(undefined);
  }, [runId]);

  if (artifacts.length === 0) return null;
  const openPreview = async (artifact: StudioArtifactSummary) => {
    setSelected(artifact);
    setPreview(undefined);
    setError(undefined);
    try {
      setPreview(await api.artifactPreview(runId, artifact.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section class="run-section" aria-labelledby="artifacts-title">
      <header class="section-heading"><h2 id="artifacts-title">Outputs</h2></header>
      <ul class="artifact-list">
        {artifacts.map(artifact => {
          const meta = [artifact.mediaType, formatBytes(artifact.byteLength), formatTime(artifact.createdAt)]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={artifact.id}>
              {artifact.preview.allowed ? (
                <button class="artifact-row" type="button" onClick={() => void openPreview(artifact)}>
                  <strong>{artifact.name}</strong><span>{meta}</span>
                </button>
              ) : (
                <div class="artifact-row artifact-row-static">
                  <strong>{artifact.name}</strong><span>{meta}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {selected && (
        <ArtifactPreviewDialog
          artifact={selected}
          preview={preview}
          error={error}
          onClose={() => setSelected(undefined)}
        />
      )}
    </section>
  );
}
