import fs from 'node:fs';
import path from 'node:path';

/**
 * Produce one stable, absolute workspace identity for durable execution state.
 * Existing paths are resolved through symlinks; a not-yet-created path still
 * receives a normalized absolute identity.
 */
export function canonicalWorkspace(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Workflow workspace must be a non-empty path');
  }
  if (value.includes('\0')) throw new Error('Workflow workspace contains a null byte');
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    throw error;
  }
}
