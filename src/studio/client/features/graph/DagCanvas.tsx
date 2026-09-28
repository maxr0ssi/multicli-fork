import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { WorkflowEdge, WorkflowNode } from '../../../../workflows/domain.js';
import { edgePath, layoutDag, type PositionedNode } from './layoutDag.js';
import {
  centerMapPoint,
  fitMap,
  zoomMapAt,
  type MapTransform,
} from './mapTransform.js';

interface DagProfileSummary {
  readonly label: string;
  readonly model: string;
}

export interface DagGraph {
  readonly key: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly profiles: Readonly<Record<string, DagProfileSummary>>;
}

export interface DagNodePresentation {
  readonly detail?: string;
  readonly state?: string;
  readonly statusLabel?: string;
}

interface DagCanvasProps {
  readonly graph: DagGraph;
  readonly selectedNodeId?: string;
  readonly onSelect: (nodeId: string) => void;
  readonly showHeading?: boolean;
  readonly headingDetail?: string;
  readonly nodePresentation?: (node: WorkflowNode) => DagNodePresentation;
}

function readableStatus(value: string): string {
  return value.replaceAll('_', ' ');
}

function nextDirectionalNode(
  current: PositionedNode,
  nodes: readonly PositionedNode[],
  key: string,
): PositionedNode | undefined {
  const currentCenter = {
    x: current.x + current.width / 2,
    y: current.y + current.height / 2,
  };
  const candidates = nodes.filter(candidate => {
    if (candidate.node.id === current.node.id) return false;
    const x = candidate.x + candidate.width / 2 - currentCenter.x;
    const y = candidate.y + candidate.height / 2 - currentCenter.y;
    if (key === 'ArrowRight') return x > 0;
    if (key === 'ArrowLeft') return x < 0;
    if (key === 'ArrowDown') return y > 0;
    return y < 0;
  });
  return candidates.sort((left, right) => {
    const score = (candidate: PositionedNode) => {
      const x = candidate.x + candidate.width / 2 - currentCenter.x;
      const y = candidate.y + candidate.height / 2 - currentCenter.y;
      return key === 'ArrowLeft' || key === 'ArrowRight'
        ? Math.abs(x) + Math.abs(y) * 2
        : Math.abs(y) + Math.abs(x) * 2;
    };
    return score(left) - score(right);
  })[0];
}

export function DagCanvas({
  graph,
  selectedNodeId,
  onSelect,
  showHeading = true,
  headingDetail,
  nodePresentation,
}: DagCanvasProps) {
  const layout = useMemo(
    () => layoutDag(graph.nodes, graph.edges),
    [graph.nodes, graph.edges],
  );
  const surface = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const pan = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  }>();
  const [transform, setTransform] = useState<MapTransform>({ x: 0, y: 0, scale: 1 });
  const [panning, setPanning] = useState(false);
  const byId = new Map(layout.nodes.map(node => [node.node.id, node]));
  const fit = useCallback(() => {
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    setTransform(fitMap(
      { width: bounds.width, height: bounds.height },
      { width: layout.width, height: layout.height },
    ));
  }, [layout.height, layout.width]);

  useEffect(() => {
    if (showHeading || !viewport.current) return undefined;
    const frame = requestAnimationFrame(fit);
    const observer = new ResizeObserver(fit);
    observer.observe(viewport.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fit, graph.key, showHeading]);

  const centerNode = (nodeId: string) => {
    if (showHeading) return;
    const bounds = viewport.current?.getBoundingClientRect();
    const positioned = byId.get(nodeId);
    if (!bounds || !positioned) return;
    setTransform(current => centerMapPoint(
      { width: bounds.width, height: bounds.height },
      {
        x: positioned.x + positioned.width / 2,
        y: positioned.y + positioned.height / 2,
      },
      current.scale,
    ));
  };
  const focusNode = (nodeId: string) => {
    const button = surface.current?.querySelector<HTMLButtonElement>(
      `[data-node-id="${CSS.escape(nodeId)}"]`,
    );
    button?.focus({ preventScroll: true });
    centerNode(nodeId);
  };
  const zoomFromCenter = (factor: number) => {
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds) return;
    setTransform(current => zoomMapAt(
      current,
      { x: bounds.width / 2, y: bounds.height / 2 },
      current.scale * factor,
    ));
  };
  const onWheel = (event: JSX.TargetedWheelEvent<HTMLDivElement>) => {
    if (showHeading) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    setTransform(current => zoomMapAt(
      current,
      anchor,
      current.scale * Math.exp(-event.deltaY * 0.001),
    ));
  };
  const startPan = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (showHeading || (event.target as Element).closest('button')) return;
    pan.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.x,
      originY: transform.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
  };
  const movePan = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const gesture = pan.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    setTransform(current => ({
      ...current,
      x: gesture.originX + event.clientX - gesture.startX,
      y: gesture.originY + event.clientY - gesture.startY,
    }));
  };
  const endPan = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (pan.current?.pointerId !== event.pointerId) return;
    pan.current = undefined;
    setPanning(false);
  };

  return (
    <section
      class="dag-region"
      aria-labelledby={showHeading ? 'workflow-graph-title' : undefined}
      aria-label={showHeading ? undefined : 'Workflow graph'}
    >
      {showHeading && (
        <header class="section-heading">
          <div>
            <h2 id="workflow-graph-title">Workflow</h2>
            <p>{graph.nodes.length} nodes{headingDetail ? ` · ${headingDetail}` : ''}</p>
          </div>
        </header>
      )}
      {layout.cyclicNodeIds.length > 0 && (
        <p class="notice notice-danger" role="alert">
          This revision contains a cycle. Cyclic nodes are shown after the valid graph.
        </p>
      )}
      <div
        class={`dag-scroll${showHeading ? '' : ' dag-map-viewport'}`}
        aria-label={showHeading
          ? 'Workflow graph. Use arrow keys to move between nodes.'
          : 'Workflow map. Drag empty space to pan, use the wheel to zoom, and arrow keys to move between nodes.'}
        data-panning={panning}
        ref={viewport}
        onWheel={onWheel}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        {!showHeading && (
          <div class="dag-map-toolbar" aria-label="Workflow map controls">
            <button class="button" type="button" onClick={() => zoomFromCenter(0.8)}>
              Zoom out
            </button>
            <output aria-label="Current zoom">{Math.round(transform.scale * 100)}%</output>
            <button class="button" type="button" onClick={fit}>Fit map</button>
            <button class="button" type="button" onClick={() => zoomFromCenter(1.25)}>
              Zoom in
            </button>
          </div>
        )}
        <div
          class="dag-surface"
          ref={surface}
          role="list"
          style={{
            width: layout.width,
            height: layout.height,
            ...(showHeading
              ? {}
              : {
                transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                transformOrigin: '0 0',
              }),
          }}
        >
          <svg
            class="dag-edges"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
          >
            {graph.edges.map(edge => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              return from && to ? <path key={`${edge.from}:${edge.to}`} d={edgePath(from, to)} /> : null;
            })}
          </svg>
          {layout.nodes.map((positioned, index) => {
            const node = positioned.node;
            const profile = node.kind === 'agent' ? graph.profiles[node.profileId] : undefined;
            const presentation = nodePresentation?.(node);
            const status = presentation?.state;
            const selected = node.id === selectedNodeId;
            const relationsId = `dag-node-relations-${index}`;
            const incoming = graph.edges.filter(edge => edge.to === node.id);
            const outgoing = graph.edges.filter(edge => edge.from === node.id);
            const relationText = [
              incoming.length > 0 ? `Needs ${incoming.map(edge => edge.from).join(', ')}.` : '',
              outgoing.length > 0 ? `Unlocks ${outgoing.map(edge => edge.to).join(', ')}.` : '',
            ].filter(Boolean).join(' ');
            return (
              <div
                class="dag-node-position"
                role="listitem"
                key={node.id}
                style={{
                  left: positioned.x,
                  top: positioned.y,
                  width: positioned.width,
                  height: positioned.height,
                }}
              >
                <button
                  type="button"
                  class="dag-node"
                  data-node-id={node.id}
                  data-state={status}
                  aria-pressed={selected}
                  aria-describedby={relationText ? relationsId : undefined}
                  tabIndex={selected || (!selectedNodeId && index === 0) ? 0 : -1}
                  onClick={() => onSelect(node.id)}
                  onKeyDown={event => {
                    if (event.key === 'Home' || event.key === 'End') {
                      const target = event.key === 'Home' ? layout.nodes[0] : layout.nodes.at(-1);
                      if (!target) return;
                      event.preventDefault();
                      onSelect(target.node.id);
                      queueMicrotask(() => focusNode(target.node.id));
                      return;
                    }
                    if (!event.key.startsWith('Arrow')) return;
                    const target = nextDirectionalNode(positioned, layout.nodes, event.key);
                    if (!target) return;
                    event.preventDefault();
                    onSelect(target.node.id);
                    queueMicrotask(() => focusNode(target.node.id));
                  }}
                >
                  <span class="dag-node-label">{node.label}</span>
                  <span class="dag-node-detail">
                    {presentation?.detail ?? (profile ? `${profile.label} · ${profile.model}` : node.kind)}
                  </span>
                  {status && (
                    <span class="status-text" data-state={status}>
                      {presentation?.statusLabel ?? readableStatus(status)}
                    </span>
                  )}
                </button>
                {relationText && <span class="sr-only" id={relationsId}>{relationText}</span>}
              </div>
            );
          })}
        </div>
        {!showHeading && <p class="dag-map-help">Drag to pan · wheel to zoom</p>}
      </div>
    </section>
  );
}
