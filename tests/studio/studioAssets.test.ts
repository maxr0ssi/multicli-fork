import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { studioAsset } from '../../src/studio/studioAssets.js';

describe('Studio assets', () => {
  it('resolves only the packaged client assets', () => {
    expect(studioAsset('studio.js')).toMatchObject({
      contentType: 'text/javascript; charset=utf-8',
    });
    expect(path.basename(studioAsset('studio.css')!.path)).toBe('studio.css');
    expect(studioAsset('../package.json')).toBeUndefined();
    expect(studioAsset('missing.js')).toBeUndefined();
  });
});
