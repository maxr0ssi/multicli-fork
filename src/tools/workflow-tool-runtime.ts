import path from 'node:path';

import type { MultiCliConfig } from '../config.js';
import type { ToolExecutionContext } from '../execution.js';
import { createLocalOrchestrator, type LocalOrchestrator } from '../localOrchestrator.js';
import type { Logger } from '../logger.js';
import { canonicalWorkspace } from '../utils/canonicalWorkspace.js';

export interface WorkflowToolRuntime {
  readonly orchestrator: LocalOrchestrator;
  readonly controlPlane: LocalOrchestrator['controlPlane'];
  readonly runner: LocalOrchestrator['runner'];
  readonly storePath: string;
  readonly artifactRoot: string;
}

/** One owner per server; HTTP sessions borrow its workspace runtimes. */
export class WorkflowRuntimeOwner {
  readonly #runtimes = new Map<string, WorkflowToolRuntime>();
  #closing: Promise<void> | undefined;

  readonly storePath: string;
  readonly #killGraceMs: number;

  constructor(config: MultiCliConfig, private readonly logger?: Logger) {
    this.storePath = config.runStorePath === ':memory:' ? ':memory:' : path.resolve(config.runStorePath);
    this.#killGraceMs = config.killGraceMs;
  }

  assertCompatible(config: MultiCliConfig): void {
    const storePath = config.runStorePath === ':memory:' ? ':memory:' : path.resolve(config.runStorePath);
    if (storePath !== this.storePath || config.killGraceMs !== this.#killGraceMs) {
      throw new Error('Supplied workflow runtime must match the server runStorePath and killGraceMs');
    }
  }

  get(cwd: string): WorkflowToolRuntime {
    if (this.#closing) throw new Error('Workflow runtime owner is closed');
    const workspace = canonicalWorkspace(cwd);
    const existing = this.#runtimes.get(workspace);
    if (existing) return existing;
    const storePath = this.storePath;
    const artifactRoot = storePath === ':memory:'
      ? path.join(workspace, '.multicli', 'artifacts')
      : path.join(path.dirname(storePath), 'artifacts');
    const orchestrator = createLocalOrchestrator({
      workspace,
      storePath,
      artifactRoot,
      killGraceMs: this.#killGraceMs,
      logger: this.logger,
    });
    const runtime = {
      orchestrator,
      controlPlane: orchestrator.controlPlane,
      runner: orchestrator.runner,
      storePath,
      artifactRoot,
    };
    this.#runtimes.set(workspace, runtime);
    return runtime;
  }

  close(): Promise<void> {
    this.#closing ??= Promise.allSettled(
      [...this.#runtimes.values()].map(runtime => runtime.orchestrator.close()),
    ).then(results => {
      this.#runtimes.clear();
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
    return this.#closing;
  }
}

export function workflowToolRuntime(context?: ToolExecutionContext): WorkflowToolRuntime {
  if (!context?.workflowRuntime) throw new Error('Workflow tools require a server-owned runtime');
  return context.workflowRuntime(context.cwd ?? process.cwd());
}
