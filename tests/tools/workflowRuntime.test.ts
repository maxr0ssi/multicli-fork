import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { WorkflowRuntimeOwner, workflowToolRuntime } from '../../src/tools/workflow-tool-runtime.js';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('server-owned workflow runtimes', () => {
  it('uses the server config, shares each workspace, and closes every runtime once', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-runtime-'));
    directories.push(directory);
    const storePath = path.join(directory, 'configured.sqlite');
    const otherPath = path.join(directory, 'environment.sqlite');
    const config = loadConfig({ MULTICLI_RUN_STORE_PATH: storePath });
    const owner = new WorkflowRuntimeOwner(config);
    config.runStorePath = otherPath;
    vi.stubEnv('MULTICLI_RUN_STORE_PATH', otherPath);
    const first = owner.get(directory);
    const secondDirectory = path.join(directory, 'other-workspace');
    fs.mkdirSync(secondDirectory);
    const second = owner.get(secondDirectory);
    const closeFirst = vi.spyOn(first.orchestrator, 'close');
    const closeSecond = vi.spyOn(second.orchestrator, 'close');
    expect(owner.get(path.join(directory, '.'))).toBe(first);
    expect(first.storePath).toBe(storePath);
    expect(first.controlPlane).toBe(first.orchestrator.controlPlane);
    expect(fs.existsSync(otherPath)).toBe(false);
    expect(workflowToolRuntime({ cwd: directory, workflowRuntime: cwd => owner.get(cwd) })).toBe(first);
    await Promise.all([owner.close(), owner.close()]);
    expect(closeFirst).toHaveBeenCalledTimes(1);
    expect(closeSecond).toHaveBeenCalledTimes(1);
    expect(first.orchestrator.closed).toBe(true);
    expect(second.orchestrator.closed).toBe(true);
    expect(() => first.controlPlane.listRuns()).toThrow();
    expect(() => owner.get(directory)).toThrow('closed');
  });

  it('rejects incompatible borrowed configuration without closing the owner', async () => {
    const config = loadConfig({ MULTICLI_RUN_STORE_PATH: ':memory:' });
    const owner = new WorkflowRuntimeOwner(config);
    owner.assertCompatible({ ...config });
    expect(() => owner.assertCompatible({ ...config, runStorePath: '/tmp/another.sqlite' })).toThrow('must match');
    expect(() => owner.assertCompatible({ ...config, killGraceMs: 1 })).toThrow('must match');
    await owner.close();
  });

  it('requires explicit ownership rather than opening an implicit database', () => {
    expect(() => workflowToolRuntime()).toThrow('server-owned runtime');
  });
});
