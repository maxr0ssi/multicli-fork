import { describe, expect, it } from 'vitest';

import {
  centerMapPoint,
  fitMap,
  zoomMapAt,
} from '../../../src/studio/client/features/graph/mapTransform.js';

describe('workflow map transforms', () => {
  it('fits and centers the complete topology inside a padded viewport', () => {
    expect(fitMap(
      { width: 1000, height: 700 },
      { width: 1800, height: 900 },
    )).toEqual({ scale: 0.52, x: 32, y: 116 });
  });

  it('keeps the map point under the cursor stable while zooming', () => {
    const current = { x: 80, y: 40, scale: 0.5 };
    const anchor = { x: 500, y: 300 };
    const before = {
      x: (anchor.x - current.x) / current.scale,
      y: (anchor.y - current.y) / current.scale,
    };
    const zoomed = zoomMapAt(current, anchor, 1.25);

    expect((anchor.x - zoomed.x) / zoomed.scale).toBeCloseTo(before.x);
    expect((anchor.y - zoomed.y) / zoomed.scale).toBeCloseTo(before.y);
  });

  it('centers a keyboard-selected node without changing zoom', () => {
    expect(centerMapPoint(
      { width: 1200, height: 800 },
      { x: 900, y: 300 },
      0.75,
    )).toEqual({ scale: 0.75, x: -75, y: 175 });
  });
});
