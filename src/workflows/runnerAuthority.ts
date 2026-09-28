import { randomUUID } from 'node:crypto';

import type { RunLedger } from '../persistence/runLedger.js';
import { canonicalWorkspace } from '../utils/canonicalWorkspace.js';

const DEFAULT_AUTHORITY_LEASE_MS = 60_000;

/**
 * One renewable lease elects the sole workflow-driving process for a workspace.
 * Its timer is independent of provider output, so a silent model does not look dead.
 */
export class RunnerAuthorityLease {
  readonly workspace: string;
  readonly owner: string;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  #heartbeat: NodeJS.Timeout | undefined;
  #held = false;
  #leaseExpiresAt = 0;

  constructor(private readonly options: {
    ledger: RunLedger;
    workspace: string;
    leaseMs?: number;
    onLost: (error: unknown) => void;
  }) {
    this.workspace = canonicalWorkspace(options.workspace);
    this.owner = `workflow-runner:${process.pid}:${randomUUID()}`;
    this.#leaseMs = options.leaseMs ?? DEFAULT_AUTHORITY_LEASE_MS;
    if (!Number.isFinite(this.#leaseMs) || this.#leaseMs <= 0) {
      throw new Error('Workflow runner authority leaseMs must be positive');
    }
    this.#heartbeatMs = Math.max(50, Math.min(10_000, Math.floor(this.#leaseMs / 3)));
  }

  get held(): boolean {
    return this.#held;
  }

  tryAcquire(): boolean {
    if (this.#held) return this.renew();
    const authority = this.options.ledger.claimWorkflowRunnerAuthority({
      workspace: this.workspace,
      owner: this.owner,
      leaseMs: this.#leaseMs,
    });
    if (!authority) return false;
    this.#held = true;
    this.#leaseExpiresAt = Date.parse(authority.leaseExpiresAt);
    this.#startHeartbeat();
    return true;
  }

  /** Wait for the elected owner to release or expire; cancellation stops the follower. */
  async acquire(signal: AbortSignal): Promise<boolean> {
    while (!signal.aborted) {
      try {
        if (this.tryAcquire()) return true;
      } catch (error) {
        if (!isTransientSqliteContention(error)) throw error;
      }
      await new Promise<void>(resolve => {
        const stop = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', stop);
          resolve();
        }, 100);
        signal.addEventListener('abort', stop, { once: true });
      });
    }
    return false;
  }

  renew(): boolean {
    if (!this.#held) return false;
    try {
      const authority = this.options.ledger.renewWorkflowRunnerAuthority({
        workspace: this.workspace,
        owner: this.owner,
        leaseMs: this.#leaseMs,
      });
      this.#leaseExpiresAt = Date.parse(authority.leaseExpiresAt);
      return true;
    } catch (error) {
      if (isTransientSqliteContention(error) && Date.now() < this.#leaseExpiresAt) {
        return true;
      }
      this.#lose(error);
      return false;
    }
  }

  release(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    const held = this.#held;
    this.#held = false;
    this.#leaseExpiresAt = 0;
    if (held) {
      try {
        this.options.ledger.releaseWorkflowRunnerAuthority({
          workspace: this.workspace,
          owner: this.owner,
        });
      } catch (error) {
        if (!isTransientSqliteContention(error)) throw error;
        // The bounded lease remains the safe cleanup path after lock contention.
      }
    }
  }

  #startHeartbeat(): void {
    if (this.#heartbeat) return;
    this.#heartbeat = setInterval(() => this.renew(), this.#heartbeatMs);
    this.#heartbeat.unref?.();
  }

  #lose(error: unknown): void {
    if (!this.#held) return;
    this.#held = false;
    this.#leaseExpiresAt = 0;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.options.onLost(error);
  }
}

function isTransientSqliteContention(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate?.code === 'SQLITE_BUSY'
    || (typeof candidate?.message === 'string'
      && /database (?:is )?locked|SQLITE_BUSY/i.test(candidate.message));
}
