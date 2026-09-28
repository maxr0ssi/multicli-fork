import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';

describe('logger', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes structured JSON lines with child bindings and serialized errors', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'multicli-logger-'));
    tempDirs.push(dir);
    const logPath = path.join(dir, 'multicli.log');
    const logger = createLogger({
      filePath: logPath,
      fileLevel: 'debug',
      stderrLevel: 'silent',
      bindings: { component: 'testRoot' },
    }).child({
      component: 'childComponent',
      requestId: 'req-123',
    });

    logger.error('structured_event', {
      error: new Error('boom'),
      prompt: 'FULL PROMPT BODY',
    });

    const [line] = readFileSync(logPath, 'utf8').trim().split('\n');
    const parsed = JSON.parse(line);

    expect(parsed.event).toBe('structured_event');
    expect(parsed.component).toBe('childComponent');
    expect(parsed.requestId).toBe('req-123');
    expect(parsed.meta.prompt).toBe('[Redacted]');
    expect(parsed.meta.error.message).toBe('boom');
    expect(parsed.sessionId).toBeTruthy();
    expect(parsed.pid).toBe(process.pid);
    if (process.platform !== 'win32') {
      expect(statSync(logPath).mode & 0o077).toBe(0);
    }
  });

  it('serializes cyclic error causes without recursing forever', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'multicli-logger-'));
    tempDirs.push(dir);
    const logPath = path.join(dir, 'multicli.log');
    const logger = createLogger({
      filePath: logPath,
      fileLevel: 'debug',
      stderrLevel: 'silent',
    });

    const error = new Error('cyclic');
    error.cause = error;

    logger.error('cyclic_error', { error });

    const [line] = readFileSync(logPath, 'utf8').trim().split('\n');
    const parsed = JSON.parse(line);
    expect(parsed.meta.error.cause).toBe('[Circular]');
  });

  it('rotates logs without failing when the oldest backup already exists', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'multicli-logger-'));
    tempDirs.push(dir);
    const logPath = path.join(dir, 'multicli.log');

    writeFileSync(logPath, 'x'.repeat(11 * 1024 * 1024), 'utf8');
    for (let index = 1; index <= 5; index += 1) {
      writeFileSync(`${logPath}.${index}`, `backup-${index}`, 'utf8');
    }

    const logger = createLogger({
      filePath: logPath,
      fileLevel: 'debug',
      stderrLevel: 'silent',
    });

    logger.info('post_rotation_entry', { ok: true });

    expect(existsSync(`${logPath}.6`)).toBe(false);
    expect(readFileSync(`${logPath}.5`, 'utf8')).toBe('backup-4');
    expect(readFileSync(logPath, 'utf8')).toContain('post_rotation_entry');
  });

  it('does not change permissions on an existing configured parent directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'multicli-logger-parent-'));
    tempDirs.push(root);
    const sharedParent = path.join(root, 'shared');
    mkdirSync(sharedParent, { mode: 0o755 });
    if (process.platform !== 'win32') chmodSync(sharedParent, 0o755);

    const logger = createLogger({
      filePath: path.join(sharedParent, 'multicli.log'),
      fileLevel: 'debug',
      stderrLevel: 'silent',
    });
    logger.info('permission_boundary');

    if (process.platform !== 'win32') {
      expect(statSync(sharedParent).mode & 0o777).toBe(0o755);
      expect(statSync(logger.logPath).mode & 0o077).toBe(0);
    }
  });
});
