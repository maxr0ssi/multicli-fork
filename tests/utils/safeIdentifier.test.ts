import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isSafeLocalIdentifier,
  resolveContainedPath,
} from '../../src/utils/safeIdentifier.js';

describe('safe local identifiers and paths', () => {
  it('accepts workflow slugs and rejects separators or traversal', () => {
    expect(isSafeLocalIdentifier('opus-review_1.v2')).toBe(true);
    expect(isSafeLocalIdentifier('../../escaped')).toBe(false);
    expect(isSafeLocalIdentifier('nested/review')).toBe(false);
    expect(isSafeLocalIdentifier('nested\\review')).toBe(false);
  });

  it('resolves child paths only beneath the required parent', () => {
    const root = path.resolve('/tmp/multicli-artifacts');
    expect(resolveContainedPath(root, 'run-id', 'review-1.md'))
      .toBe(path.join(root, 'run-id', 'review-1.md'));
    expect(() => resolveContainedPath(root, '../../escaped.md')).toThrow(/escapes/i);
    expect(() => resolveContainedPath(root, '.')).toThrow(/escapes/i);
  });
});
