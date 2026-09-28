import { eventMessage, formatTime, readableState } from '../../format.js';
import type { StudioRunView } from '../../types.js';

interface EventTimelineProps {
  readonly view: StudioRunView;
  readonly selectedNodeId?: string;
}

export function eventNodeId(payload: unknown): string | undefined {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    && typeof (payload as Record<string, unknown>).nodeId === 'string'
    ? String((payload as Record<string, unknown>).nodeId)
    : undefined;
}

export function EventTimeline({ view, selectedNodeId }: EventTimelineProps) {
  if (view.events.length === 0) return null;
  const events = selectedNodeId
    ? view.events.filter(event => eventNodeId(event.payload) === selectedNodeId)
    : view.events;
  if (events.length === 0) return null;
  return (
    <section class="run-section" aria-labelledby="timeline-title">
      <header class="section-heading"><h2 id="timeline-title">{selectedNodeId ? 'Node events' : 'Timeline'}</h2></header>
      <ol class="event-list">
        {[...events].reverse().map(event => (
          <li key={event.sequence}>
            <div class="event-heading">
              <strong>{readableState(event.type)}</strong>
              <time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time>
            </div>
            <p>{eventMessage(event.type, event.payload)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
