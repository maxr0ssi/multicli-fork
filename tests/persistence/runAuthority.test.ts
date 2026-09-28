import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteRunLedger } from '../../src/persistence/runLedger.js';

const ledgers: SqliteRunLedger[] = [];
const directories: string[] = [];

function openPair() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-authority-'));
  directories.push(directory);
  const databasePath = path.join(directory, 'runs.sqlite');
  const first = new SqliteRunLedger(databasePath);
  const second = new SqliteRunLedger(databasePath);
  ledgers.push(first, second);
  return { directory, first, second };
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('workflow runner authority', () => {
  it('pins new runs to one canonical absolute workspace', () => {
    const { directory, first } = openPair();
    const workspace = path.join(directory, 'workspace');
    const alias = path.join(directory, 'workspace-alias');
    fs.mkdirSync(workspace);
    fs.symlinkSync(workspace, alias, 'dir');
    const revision = first.recordWorkflowRevision({
      workflowId: 'workspace-pin', definition: { nodes: [] },
    });

    const run = first.createRun({ workflowRevisionId: revision.id, workspace: alias });

    expect(run.workspace).toBe(fs.realpathSync.native(workspace));
    expect(path.isAbsolute(run.workspace!)).toBe(true);
    expect(() => first.createRun({
      workflowRevisionId: revision.id,
      workspace: '' as string,
    })).toThrow(/workspace must be a non-empty path/i);
  });

  it('elects one owner, renews silently, and permits takeover only after expiry', () => {
    const { directory, first, second } = openPair();
    const workspace = path.join(directory, 'workspace');
    fs.mkdirSync(workspace);
    const initial = first.claimWorkflowRunnerAuthority({
      workspace, owner: 'mcp-runtime', leaseMs: 1_000,
      now: '2026-08-09T12:00:00.000Z',
    });

    expect(initial).toMatchObject({ owner: 'mcp-runtime' });
    expect(second.claimWorkflowRunnerAuthority({
      workspace, owner: 'studio-runtime', leaseMs: 1_000,
      now: '2026-08-09T12:00:00.500Z',
    })).toBeUndefined();
    expect(first.renewWorkflowRunnerAuthority({
      workspace, owner: 'mcp-runtime', leaseMs: 1_000,
      now: '2026-08-09T12:00:00.750Z',
    }).leaseExpiresAt).toBe('2026-08-09T12:00:01.750Z');
    expect(second.claimWorkflowRunnerAuthority({
      workspace, owner: 'studio-runtime', leaseMs: 1_000,
      now: '2026-08-09T12:00:01.100Z',
    })).toBeUndefined();

    expect(second.claimWorkflowRunnerAuthority({
      workspace, owner: 'studio-runtime', leaseMs: 1_000,
      now: '2026-08-09T12:00:01.751Z',
    })).toMatchObject({ owner: 'studio-runtime' });
    expect(() => first.renewWorkflowRunnerAuthority({
      workspace, owner: 'mcp-runtime', leaseMs: 1_000,
      now: '2026-08-09T12:00:01.800Z',
    })).toThrow(/not held/);
    expect(first.releaseWorkflowRunnerAuthority({ workspace, owner: 'mcp-runtime' })).toBe(false);
    expect(second.releaseWorkflowRunnerAuthority({ workspace, owner: 'studio-runtime' })).toBe(true);
  });

  it('waits through bounded cross-process SQLite contention during a heartbeat', async () => {
    const { directory, first } = openPair();
    const workspace = path.join(directory, 'workspace');
    fs.mkdirSync(workspace);
    first.claimWorkflowRunnerAuthority({
      workspace,
      owner: 'heartbeat-owner',
      leaseMs: 10_000,
    });
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      [
        "import { DatabaseSync } from 'node:sqlite';",
        'const database = new DatabaseSync(process.argv[1]);',
        "database.exec('BEGIN IMMEDIATE');",
        "process.stdout.write('ready\\n');",
        "setTimeout(() => { database.exec('COMMIT'); database.close(); }, 150);",
      ].join('\n'),
      first.databasePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', () => resolve());
    });

    const startedAt = Date.now();
    const renewed = first.renewWorkflowRunnerAuthority({
      workspace,
      owner: 'heartbeat-owner',
      leaseMs: 10_000,
    });
    const elapsed = Date.now() - startedAt;
    await new Promise<void>((resolve, reject) => {
      const finish = (code: number | null) => code === 0
        ? resolve()
        : reject(new Error(`SQLite contention child exited ${code}`));
      if (child.exitCode !== null) finish(child.exitCode);
      else {
        child.once('error', reject);
        child.once('exit', finish);
      }
    });

    expect(renewed.owner).toBe('heartbeat-owner');
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(elapsed).toBeLessThan(5_000);
  });
});
