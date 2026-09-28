import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { MultiCliLogLevel, MultiCliStderrLogLevel } from './config.js';

const LEVEL_PRIORITY: Record<MultiCliLogLevel, number> = {
  error: 0,
  info: 1,
  debug: 2,
};

const MAX_LOG_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_LOG_BACKUPS = 5;

function shouldWrite(
  currentLevel: MultiCliLogLevel,
  minimumLevel: MultiCliLogLevel | MultiCliStderrLogLevel,
): boolean {
  if (minimumLevel === 'silent') {
    return false;
  }

  return LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY[minimumLevel];
}

function serializeValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value instanceof Error) {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    const serialized = {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: serializeValue(value.cause, seen),
    };
    seen.delete(value);
    return serialized;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return {
      type: 'Buffer',
      length: value.length,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry, seen));
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    const serialized = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        shouldRedactKey(key) ? '[Redacted]' : serializeValue(entry, seen),
      ]),
    );
    seen.delete(value);
    return serialized;
  }

  return value;
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes('authorization')
    || normalized.includes('token')
    || normalized.includes('cookie')
    || normalized.includes('api-key')
    || normalized.includes('apikey')
    || normalized === 'arguments'
    || normalized === 'args'
    || normalized === 'body'
    || normalized === 'content'
    || normalized === 'input'
    || normalized === 'objective'
    || normalized === 'output'
    || normalized === 'prompt'
    || normalized === 'reply'
    || normalized === 'stderr'
    || normalized === 'stdout'
    || normalized.endsWith('prompt');
}

function rotateLogsIfNeeded(logPath: string) {
  try {
    if (!existsSync(logPath)) {
      return;
    }

    const { size } = statSync(logPath);
    if (size < MAX_LOG_FILE_SIZE_BYTES) {
      return;
    }

    rmSync(`${logPath}.${MAX_LOG_BACKUPS}`, { force: true });
    for (let index = MAX_LOG_BACKUPS - 1; index >= 1; index -= 1) {
      const currentPath = `${logPath}.${index}`;
      const nextPath = `${logPath}.${index + 1}`;
      if (existsSync(currentPath)) {
        renameSync(currentPath, nextPath);
      }
    }

    renameSync(logPath, `${logPath}.1`);
  } catch {
    // Rotation is best-effort only.
  }
}

export interface Logger {
  readonly logPath: string;
  readonly sessionId: string;
  child(bindings: Record<string, unknown>): Logger;
  error(event: string, meta?: Record<string, unknown>): void;
  info(event: string, meta?: Record<string, unknown>): void;
  debug(event: string, meta?: Record<string, unknown>): void;
}

interface LoggerOptions {
  filePath: string;
  fileLevel: MultiCliLogLevel;
  stderrLevel?: MultiCliStderrLogLevel;
  sessionId?: string;
  bindings?: Record<string, unknown>;
}

class StructuredLogger implements Logger {
  readonly logPath: string;
  readonly sessionId: string;

  constructor(
    private readonly options: LoggerOptions,
  ) {
    this.logPath = options.filePath;
    this.sessionId = options.sessionId ?? randomUUID();
    const directory = path.dirname(this.logPath);
    const directoryExisted = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      // A configured log path may live directly inside an existing shared
      // directory such as /tmp. Secure directories we create, but never
      // mutate permissions on a parent owned by the caller or the OS.
      if (!directoryExisted) chmodSync(directory, 0o700);
      if (existsSync(this.logPath)) chmodSync(this.logPath, 0o600);
    }
  }

  child(bindings: Record<string, unknown>): Logger {
    return new StructuredLogger({
      ...this.options,
      sessionId: this.sessionId,
      bindings: {
        ...(this.options.bindings ?? {}),
        ...bindings,
      },
    });
  }

  error(event: string, meta?: Record<string, unknown>): void {
    this.write('error', event, meta);
  }

  info(event: string, meta?: Record<string, unknown>): void {
    this.write('info', event, meta);
  }

  debug(event: string, meta?: Record<string, unknown>): void {
    this.write('debug', event, meta);
  }

  private write(
    level: MultiCliLogLevel,
    event: string,
    meta?: Record<string, unknown>,
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      sessionId: this.sessionId,
      pid: process.pid,
      ...(serializeValue(this.options.bindings ?? {}) as Record<string, unknown>),
      ...(meta ? { meta: serializeValue(meta) } : {}),
    };

    const line = `${JSON.stringify(entry)}\n`;

    try {
      if (shouldWrite(level, this.options.fileLevel)) {
        rotateLogsIfNeeded(this.logPath);
        appendFileSync(this.logPath, line, { encoding: 'utf8', mode: 0o600 });
        if (process.platform !== 'win32') chmodSync(this.logPath, 0o600);
      }
    } catch (error) {
      const fallback = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'logger_file_write_failed',
        sessionId: this.sessionId,
        pid: process.pid,
        component: 'logger',
        meta: serializeValue({
          targetPath: this.logPath,
          originalLevel: level,
          originalEvent: event,
          error,
        }),
      });
      process.stderr.write(`${fallback}\n`);
      return;
    }

    const stderrLevel = this.options.stderrLevel ?? 'error';
    if (shouldWrite(level, stderrLevel)) {
      process.stderr.write(line);
    }
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new StructuredLogger(options);
}
