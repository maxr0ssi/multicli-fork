export interface MapSize {
  readonly width: number;
  readonly height: number;
}

export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

export interface MapTransform extends MapPoint {
  readonly scale: number;
}

export const MIN_MAP_SCALE = 0.1;
export const MAX_MAP_SCALE = 2.5;

export function clampMapScale(scale: number): number {
  return Math.max(MIN_MAP_SCALE, Math.min(MAX_MAP_SCALE, scale));
}

export function fitMap(
  viewport: MapSize,
  map: MapSize,
  padding = 32,
): MapTransform {
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = clampMapScale(Math.min(
    1,
    availableWidth / Math.max(1, map.width),
    availableHeight / Math.max(1, map.height),
  ));
  return {
    scale,
    x: (viewport.width - map.width * scale) / 2,
    y: (viewport.height - map.height * scale) / 2,
  };
}

/** Preserve the map point under the cursor while its scale changes. */
export function zoomMapAt(
  current: MapTransform,
  anchor: MapPoint,
  requestedScale: number,
): MapTransform {
  const scale = clampMapScale(requestedScale);
  const ratio = scale / current.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - current.x) * ratio,
    y: anchor.y - (anchor.y - current.y) * ratio,
  };
}

export function centerMapPoint(
  viewport: MapSize,
  point: MapPoint,
  scale: number,
): MapTransform {
  return {
    scale,
    x: viewport.width / 2 - point.x * scale,
    y: viewport.height / 2 - point.y * scale,
  };
}
