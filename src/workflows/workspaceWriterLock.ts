/** FIFO process-local mutex for workspace-mutating workflow nodes. */
export class WorkspaceWriterLock {
  #tail: Promise<void> = Promise.resolve();

  async run(work: () => Promise<void>): Promise<void> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      await work();
    } finally {
      release();
    }
  }
}

/** FIFO concurrency bound shared by every active run in one local runner. */
export class RunnerAgentSemaphore {
  readonly #waiters: Array<() => void> = [];
  #available: number;

  constructor(capacity: number) {
    this.#available = capacity;
  }

  async run(work: () => Promise<void>): Promise<void> {
    await this.#acquire();
    try {
      await work();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve();
    }
    return new Promise(resolve => this.#waiters.push(resolve));
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#available += 1;
  }
}
