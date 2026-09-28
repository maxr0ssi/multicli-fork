import path from 'node:path';

import { loadConfig } from '../config.js';
import { LocalControlPlane } from '../controlPlane/controlPlane.js';
import type { Logger } from '../logger.js';
import { SqliteRunLedger } from '../persistence/runLedger.js';
import { LocalSubscriptionCliExecutor } from '../workflows/executor.js';
import { LocalWorkflowRunner } from '../workflows/runner.js';
import { canonicalWorkspace } from '../utils/canonicalWorkspace.js';

export interface WorkflowToolRuntime {
  readonly controlPlane: LocalControlPlane;
  readonly runner: LocalWorkflowRunner;
  readonly storePath: string;
}

const runtimes = new Map<string, WorkflowToolRuntime>();

/** Share one local ledger/runtime across every workflow-facing MCP tool. */
export function workflowToolRuntime(
  cwd: string,
  logger?: Logger,
): WorkflowToolRuntime {
  const workspace = canonicalWorkspace(cwd);
  const config = loadConfig();
  const storePath = config.runStorePath === ':memory:'
    ? config.runStorePath
    : path.resolve(config.runStorePath);
  const key = `${storePath}\0${workspace}`;
  const existing = runtimes.get(key);
  if (existing) return existing;

  const controlPlane = new LocalControlPlane(new SqliteRunLedger(storePath));
  const runtime = {
    controlPlane,
    storePath,
    runner: new LocalWorkflowRunner({
      controlPlane,
      executor: new LocalSubscriptionCliExecutor({
        killGraceMs: config.killGraceMs,
        logger,
      }),
      workspace,
      artifactRoot: path.join(path.dirname(storePath), 'artifacts'),
    }),
  };
  runtimes.set(key, runtime);
  return runtime;
}
