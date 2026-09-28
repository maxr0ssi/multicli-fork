import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  localUrlOpenPlan,
  openLocalUrl,
  parseStudioLaunchArgs,
  studioLaunchTargetFromArgs,
  studioWorkspaceFromArgs,
} from '../../src/studio/launcher.js';

describe('Studio launcher', () => {
  it('parses exact draft and run destinations before starting a server', () => {
    expect(studioLaunchTargetFromArgs(['--draft', 'draft-1', '--no-open']))
      .toEqual({ draftId: 'draft-1' });
    expect(studioLaunchTargetFromArgs(['--run', 'run-1', '--node', 'review-1']))
      .toEqual({ runId: 'run-1', nodeId: 'review-1' });
    expect(() => studioLaunchTargetFromArgs(['--draft', '../../escape'])).toThrow(/--draft/);
    expect(() => studioLaunchTargetFromArgs(['--node', 'review-1'])).toThrow(/requires --run/);
  });

  it('resolves an explicit existing workflow workspace', () => {
    expect(studioWorkspaceFromArgs(['--workspace', '.'], process.cwd())).toBe(process.cwd());
    expect(studioWorkspaceFromArgs([], process.cwd())).toBeUndefined();
    expect(() => studioWorkspaceFromArgs(['--workspace'], process.cwd()))
      .toThrow(/requires a directory/);
  });

  it('pins an existing SQLite authority and rejects unknown or duplicate options', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-studio-launch-'));
    const storePath = path.join(directory, 'custom.sqlite');
    fs.writeFileSync(storePath, 'sqlite fixture');
    const canonicalDirectory = fs.realpathSync(directory);
    const canonicalStorePath = fs.realpathSync(storePath);
    try {
      expect(parseStudioLaunchArgs([
        '--draft', 'draft-1', '--workspace', directory,
        '--store', storePath, '--no-open',
      ], directory)).toEqual({
        target: { draftId: 'draft-1' },
        workspace: canonicalDirectory,
        storePath: canonicalStorePath,
        noOpen: true,
      });
      expect(() => parseStudioLaunchArgs(['--store', path.join(directory, 'missing.sqlite')]))
        .toThrow(/existing file/);
      expect(() => parseStudioLaunchArgs(['--wat'])).toThrow(/Unknown Studio option/);
      expect(() => parseStudioLaunchArgs(['--run', 'one', '--run', 'two']))
        .toThrow(/Duplicate Studio option/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses native, non-shell browser commands on macOS and Linux', () => {
    const url = 'http://127.0.0.1:37420/studio/session?nonce=abc';
    expect(localUrlOpenPlan(url, 'darwin')).toEqual({ command: 'open', args: [url] });
    expect(localUrlOpenPlan(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] });
  });

  it('rejects remote and non-HTTP launch targets', () => {
    expect(() => localUrlOpenPlan('https://example.com/studio', 'darwin')).toThrow(/loopback/);
    expect(() => localUrlOpenPlan('file:///tmp/studio.html', 'darwin')).toThrow(/loopback/);
  });

  it('spawns the opener detached without a shell', () => {
    const unref = vi.fn();
    const once = vi.fn();
    const spawnProcess = vi.fn(() => ({ once, unref }) as any);
    openLocalUrl('http://localhost:1234/studio', 'darwin', spawnProcess as any);

    expect(spawnProcess).toHaveBeenCalledWith(
      'open',
      ['http://localhost:1234/studio'],
      { detached: true, shell: false, stdio: 'ignore' },
    );
    expect(once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(unref).toHaveBeenCalled();
  });
});
