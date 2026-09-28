import path from 'node:path';

export {
  isSafeLocalIdentifier,
  requireSafeLocalIdentifier,
} from './localIdentifier.js';

export function resolveContainedPath(parent: string, ...segments: string[]): string {
  const root = path.resolve(parent);
  const candidate = path.resolve(root, ...segments);
  const relative = path.relative(root, candidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error(`Resolved path escapes its required parent: ${JSON.stringify(candidate)}`);
  }
  return candidate;
}
