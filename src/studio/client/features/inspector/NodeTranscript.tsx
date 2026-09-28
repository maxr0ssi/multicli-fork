import { useEffect, useState } from 'preact/hooks';
import type { WorkflowNode } from '../../../../workflows/domain.js';

import type { StudioApi } from '../../api.js';
import { eventMessage, formatTime, readableState } from '../../format.js';
import type {
  StudioArtifactPreview,
  StudioArtifactSummary,
  StudioNodeExecution,
  StudioRunView,
  StudioWorkflowProfile,
} from '../../types.js';
import { eventNodeId } from '../timeline/EventTimeline.js';

interface NodeTranscriptProps {
  readonly api: StudioApi;
  readonly view: StudioRunView;
  readonly node: WorkflowNode;
  readonly execution?: StudioNodeExecution;
  readonly profile?: StudioWorkflowProfile;
  readonly artifacts: readonly StudioArtifactSummary[];
  readonly prompt?: string;
}

export function NodeTranscript({
  api,
  view,
  node,
  execution,
  profile,
  artifacts,
  prompt,
}: NodeTranscriptProps) {
  const latestArtifact = artifacts.at(-1);
  const [preview, setPreview] = useState<StudioArtifactPreview>();
  const [previewError, setPreviewError] = useState<string>();
  const events = view.events.filter(event => eventNodeId(event.payload) === node.id);
  const activeAttempt = execution?.attempts.find(attempt => attempt.status === 'running');

  useEffect(() => {
    let active = true;
    setPreview(undefined);
    setPreviewError(undefined);
    if (!latestArtifact?.preview.allowed) return () => { active = false; };
    void api.artifactPreview(view.run.id, latestArtifact.id)
      .then(result => { if (active) setPreview(result); })
      .catch(reason => {
        if (active) setPreviewError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { active = false; };
  }, [api, latestArtifact?.id, latestArtifact?.preview.allowed, view.run.id]);

  return (
    <section class="node-transcript" aria-label={`${node.label} transcript`} aria-live="polite">
      {prompt && (
        <article class="transcript-entry">
          <header><strong>Assigned task</strong></header>
          <pre>{prompt}</pre>
        </article>
      )}
      {events.map(event => (
        <article class="transcript-entry transcript-event" key={event.sequence}>
          <header>
            <strong>{readableState(event.type)}</strong>
            <time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time>
          </header>
          <p>{eventMessage(event.type, event.payload)}</p>
        </article>
      ))}
      {activeAttempt && !preview && (
        <article class="transcript-entry" data-state="running">
          <header><strong>{profile?.label ?? node.label}</strong></header>
          <p>
            Provider work is active
            {activeAttempt.lease
              ? `; process heartbeat renewed ${formatTime(activeAttempt.lease.lastRenewedAt)}.`
              : '.'}
          </p>
          <p class="transcript-note">
            This CLI has not committed a reply yet. Studio shows liveness, but never invents
            partial model text.
          </p>
        </article>
      )}
      {previewError && <p class="notice notice-danger" role="alert">{previewError}</p>}
      {latestArtifact && !latestArtifact.preview.allowed && (
        <p class="notice">{latestArtifact.preview.reason}</p>
      )}
      {latestArtifact?.preview.allowed && !preview && !previewError && !activeAttempt && (
        <p class="notice" aria-live="polite">Loading committed reply…</p>
      )}
      {preview && (
        <article class="transcript-entry transcript-reply">
          <header>
            <strong>{profile?.label ?? node.label}</strong>
            <span>{latestArtifact?.name}</span>
          </header>
          {preview.truncated && <p class="transcript-note">This preview is truncated.</p>}
          <pre>{preview.text}</pre>
        </article>
      )}
      {!prompt && events.length === 0 && !latestArtifact && (
        <p class="empty-state">This node has no transcript evidence yet.</p>
      )}
    </section>
  );
}
