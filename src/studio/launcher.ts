import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { StudioLaunchTarget } from '../controlPlane/studioAuth.js';
import { requireSafeLocalIdentifier } from '../utils/safeIdentifier.js';

export interface LocalUrlOpenPlan {
  command: string;
  args: string[];
}

export interface StudioLaunchRequest {
  target: StudioLaunchTarget;
  workspace?: string;
  storePath?: string;
  noOpen: boolean;
}

const VALUE_OPTIONS = new Set(['--draft', '--run', '--node', '--workspace', '--store']);

function parseOptions(args: readonly string[]): {
  values: ReadonlyMap<string, string>;
  noOpen: boolean;
} {
  const values = new Map<string, string>();
  let noOpen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--no-open') {
      if (noOpen) throw new Error('Duplicate Studio option: --no-open');
      noOpen = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(argument)) {
      throw new Error(`Unknown Studio option: ${argument}`);
    }
    if (values.has(argument)) throw new Error(`Duplicate Studio option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      const kind = argument === '--workspace'
        ? 'a directory'
        : argument === '--store' ? 'a SQLite file' : 'an id';
      throw new Error(`${argument} requires ${kind}`);
    }
    values.set(argument, value);
    index += 1;
  }
  return { values, noOpen };
}

function identifier(values: ReadonlyMap<string, string>, name: string): string | undefined {
  const value = values.get(name);
  return value === undefined ? undefined : requireSafeLocalIdentifier(value, name);
}

function existingPath(
  value: string,
  cwd: string,
  kind: 'directory' | 'file',
  optionName: string,
): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(cwd, value));
  } catch {
    throw new Error(`${optionName} must identify an existing ${kind}`);
  }
  const stats = fs.statSync(resolved);
  const matches = kind === 'directory' ? stats.isDirectory() : stats.isFile();
  if (!matches) throw new Error(`${optionName} must identify an existing ${kind}`);
  return resolved;
}

export function parseStudioLaunchArgs(
  args: readonly string[],
  cwd: string = process.cwd(),
): StudioLaunchRequest {
  const { values, noOpen } = parseOptions(args);
  const draftId = identifier(values, '--draft');
  const runId = identifier(values, '--run');
  const nodeId = identifier(values, '--node');
  if (draftId && runId) throw new Error('--draft and --run cannot be used together');
  if (nodeId && !runId) throw new Error('--node requires --run');
  return {
    target: {
      ...(draftId ? { draftId } : {}),
      ...(runId ? { runId } : {}),
      ...(nodeId ? { nodeId } : {}),
    },
    ...(values.has('--workspace')
      ? { workspace: existingPath(values.get('--workspace')!, cwd, 'directory', '--workspace') }
      : {}),
    ...(values.has('--store')
      ? { storePath: existingPath(values.get('--store')!, cwd, 'file', '--store') }
      : {}),
    noOpen,
  };
}

export function studioLaunchTargetFromArgs(args: readonly string[]): StudioLaunchTarget {
  return parseStudioLaunchArgs(args).target;
}

export function studioWorkspaceFromArgs(
  args: readonly string[],
  cwd: string = process.cwd(),
): string | undefined {
  return parseStudioLaunchArgs(args, cwd).workspace;
}

export function localUrlOpenPlan(
  url: string,
  platform: NodeJS.Platform = process.platform,
): LocalUrlOpenPlan {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'http:'
    || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
  ) {
    throw new Error('Studio may only open an HTTP loopback URL');
  }

  if (platform === 'darwin') return { command: 'open', args: [parsed.href] };
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'start', '', parsed.href],
    };
  }
  return { command: 'xdg-open', args: [parsed.href] };
}

export function openLocalUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
): ChildProcess {
  const plan = localUrlOpenPlan(url, platform);
  const child = spawnProcess(plan.command, plan.args, {
    detached: true,
    shell: false,
    stdio: 'ignore',
  });
  child.once('error', () => {
    // Opening a browser is best-effort; the CLI always prints the launch URL.
  });
  child.unref();
  return child;
}
