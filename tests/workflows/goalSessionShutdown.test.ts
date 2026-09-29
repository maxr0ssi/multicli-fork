import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryRunLedger } from '../../src/persistence/runLedger.js';
import { GoalSessionService } from '../../src/workflows/goalSession.js';
import type { WorkflowProviderExecutor } from '../../src/workflows/executor.js';

const resources: { store: ReturnType<typeof createInMemoryRunLedger>; directory: string }[] = [];
function setup(execute: WorkflowProviderExecutor['execute']) {
  const store = createInMemoryRunLedger();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-session-shutdown-'));
  resources.push({ store, directory });
  const service = new GoalSessionService({ store, artifactRoot: directory, executor: { execute } });
  const input = {
    goal: 'Review the workspace', cwd: directory,
    profile: { profileId: 'reviewer', provider: 'codex', model: 'gpt-5.6-sol',
      workspaceAccess: 'read-only', selection: 'default', enableSubagents: false } as const,
  };
  return { store, service, input, session: service.openGoalSession(input) };
}
afterEach(() => {
  for (const { store, directory } of resources.splice(0)) {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('goal session shutdown', () => {
  it('aborts active work, drains cleanup, and never starts a queued turn', async () => {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let signal: AbortSignal | undefined;
    const execute = vi.fn<WorkflowProviderExecutor['execute']>(request => {
      signal = request.signal;
      started();
      return new Promise((_resolve, reject) => {
        release = () => reject(signal?.reason);
      });
    });
    const { service, store, input, session } = setup(execute);
    const active = session.turn('First').catch(error => error);
    await ready;
    const queued = session.turn('Second').catch(error => error);
    let finished = false;
    const shutdown = service.shutdown();
    void shutdown.then(() => { finished = true; });
    expect(service.shutdown()).toBe(shutdown);
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(() => service.openGoalSession(input)).toThrow('closed');
    await expect(session.turn('Third')).rejects.toThrow('closed');
    release();
    await shutdown;
    expect(await active).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    expect(execute).toHaveBeenCalledOnce();
    expect(store.getGoalSession(session.id)?.turnState).not.toBe('running');
    expect(() => session.inspect()).toThrow('closed');
    await expect(session.close()).rejects.toThrow('closed');
  });

  it('does not invoke the provider for an already cancelled request', async () => {
    const execute = vi.fn<WorkflowProviderExecutor['execute']>();
    const { service, store, session } = setup(execute);
    const abort = new AbortController();
    abort.abort(new Error('Cancelled by caller'));
    await expect(session.turn('Review', { signal: abort.signal })).rejects.toThrow('Cancelled by caller');
    expect(execute).not.toHaveBeenCalled();
    expect(store.getGoalSession(session.id)?.turnCount).toBe(0);
    await service.shutdown();
  });
});
