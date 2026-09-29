import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('package scripts', () => {
  it('keeps source installs separate from upstream publishing', () => {
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(manifest.name).toBe('@maxr0ssi/multicli');
    expect(manifest.private).toBe(true);
    expect(manifest.repository.url).toBe('git+https://github.com/maxr0ssi/multicli-fork.git');
    expect(manifest.publishConfig).toBeUndefined();
    expect(manifest.files).toContain('NOTICE');
  });

  it('exposes only the maintained CLI and keeps the lockfile executable map in sync', () => {
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const lockfile = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
    expect(manifest.bin).toEqual({ multicli: 'dist/index.js' });
    expect(lockfile.packages[''].bin).toEqual(manifest.bin);
    expect(manifest.scripts.orchestrate).toBeUndefined();
  });

  it('fails the build when compilation or catalog copying fails', () => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.build).toContain('tsc &&');
    expect(packageJson.scripts.build).toContain('copyFileSync');
    expect(packageJson.scripts.build).not.toContain('|| true');
  });

  it('cleans obsolete build output without removing source files', () => {
    const { scripts } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-build-'));
    try {
      fs.mkdirSync(path.join(directory, 'dist'));
      fs.writeFileSync(path.join(directory, 'dist', 'deleted-tool.js'), 'stale');
      fs.writeFileSync(path.join(directory, 'source.ts'), 'keep');
      execSync(scripts.clean, { cwd: directory });
      expect(fs.existsSync(path.join(directory, 'dist'))).toBe(false);
      expect(fs.readFileSync(path.join(directory, 'source.ts'), 'utf8')).toBe('keep');
      expect(scripts.build).toMatch(/^npm run clean && tsc/);
      expect(scripts.dev).toBe('npm run build && node dist/index.js');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ships the complete maintained documentation directory', () => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      files: string[];
    };

    expect(packageJson.files).toContain('README.md');
    expect(packageJson.files).toContain('docs/');
    expect(packageJson.files).not.toContain('docs/AGENT_WORKFLOW_API.md');
  });
});
