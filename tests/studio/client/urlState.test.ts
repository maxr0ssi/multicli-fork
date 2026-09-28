import { describe, expect, it, vi } from 'vitest';

import {
  readStudioSelection,
  writeStudioSelection,
} from '../../../src/studio/client/urlState.js';

describe('Studio URL selection', () => {
  it('round-trips stable run and node ids without array indexes', () => {
    const replaceState = vi.fn();
    const location = { href: 'http://127.0.0.1:3000/studio?theme=dark' };

    writeStudioSelection({ replaceState }, location, {
      runId: 'run/a stable id',
      nodeId: 'review:2',
    });

    const url = replaceState.mock.calls[0][2] as URL;
    expect(url.searchParams.get('run')).toBe('run/a stable id');
    expect(url.searchParams.get('node')).toBe('review:2');
    expect(url.searchParams.get('theme')).toBe('dark');
    expect(readStudioSelection({ href: url.href })).toEqual({
      runId: 'run/a stable id',
      nodeId: 'review:2',
      draftId: undefined,
    });
  });

  it('makes a stable draft link mutually exclusive with a historical run selection', () => {
    const replaceState = vi.fn();
    writeStudioSelection(
      { replaceState },
      { href: 'http://127.0.0.1:3000/studio?run=old&node=old-node' },
      { draftId: 'draft/proposal 1' },
    );

    const url = replaceState.mock.calls[0][2] as URL;
    expect(url.searchParams.get('draft')).toBe('draft/proposal 1');
    expect(url.searchParams.has('run')).toBe(false);
    expect(url.searchParams.has('node')).toBe(false);
    expect(readStudioSelection({ href: url.href })).toMatchObject({
      draftId: 'draft/proposal 1',
    });
  });

  it('removes node selection when no run is selected', () => {
    const replaceState = vi.fn();
    writeStudioSelection(
      { replaceState },
      { href: 'http://127.0.0.1:3000/studio?run=old&node=old-node' },
      { nodeId: 'orphan' },
    );

    expect((replaceState.mock.calls[0][2] as URL).search).toBe('');
  });
});
