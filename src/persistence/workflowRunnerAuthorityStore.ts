import { canonicalWorkspace } from '../utils/canonicalWorkspace.js';
import {
  LedgerCore,
  nowIso,
  one,
  parseTimestamp,
  type SqlRow,
} from './ledgerCore.js';
import type {
  ClaimWorkflowRunnerAuthorityInput,
  ReleaseWorkflowRunnerAuthorityInput,
  RenewWorkflowRunnerAuthorityInput,
  WorkflowRunnerAuthorityRecord,
} from './runLedger.types.js';

function assertLeaseInput(input: ClaimWorkflowRunnerAuthorityInput): void {
  if (!input.owner.trim()) throw new Error('Workflow runner authority owner is required');
  if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
    throw new Error('Workflow runner authority leaseMs must be positive');
  }
}

function mapAuthority(row: SqlRow): WorkflowRunnerAuthorityRecord {
  return {
    workspace: String(row.workspace),
    owner: String(row.owner),
    acquiredAt: String(row.acquired_at),
    leaseExpiresAt: String(row.lease_expires_at),
    updatedAt: String(row.updated_at),
  };
}

export class WorkflowRunnerAuthorityStore {
  constructor(private readonly core: LedgerCore) {}

  get(workspace: string): WorkflowRunnerAuthorityRecord | undefined {
    const canonical = canonicalWorkspace(workspace);
    const row = one(this.core.db.prepare(
      'SELECT * FROM workflow_runner_authorities WHERE workspace = ?',
    ), canonical);
    return row ? mapAuthority(row) : undefined;
  }

  claim(
    input: ClaimWorkflowRunnerAuthorityInput,
  ): WorkflowRunnerAuthorityRecord | undefined {
    assertLeaseInput(input);
    const workspace = canonicalWorkspace(input.workspace);
    return this.core.transaction(() => {
      const now = input.now ?? nowIso();
      const claimedAt = parseTimestamp(now, 'Workflow runner authority claim time');
      const currentRow = one(this.core.db.prepare(
        'SELECT * FROM workflow_runner_authorities WHERE workspace = ?',
      ), workspace);
      const current = currentRow ? mapAuthority(currentRow) : undefined;
      const currentExpiry = current ? Date.parse(current.leaseExpiresAt) : Number.NaN;
      if (current && current.owner !== input.owner
        && Number.isFinite(currentExpiry) && currentExpiry > claimedAt) {
        return undefined;
      }
      const leaseExpiresAt = new Date(claimedAt + input.leaseMs).toISOString();
      const acquiredAt = current?.owner === input.owner ? current.acquiredAt : now;
      this.core.db.prepare(`
        INSERT INTO workflow_runner_authorities(
          workspace, owner, acquired_at, lease_expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace) DO UPDATE SET
          owner = excluded.owner,
          acquired_at = excluded.acquired_at,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at
      `).run(workspace, input.owner, acquiredAt, leaseExpiresAt, now);
      return this.get(workspace)!;
    });
  }

  renew(input: RenewWorkflowRunnerAuthorityInput): WorkflowRunnerAuthorityRecord {
    assertLeaseInput(input);
    const workspace = canonicalWorkspace(input.workspace);
    return this.core.transaction(() => {
      const now = input.now ?? nowIso();
      const heartbeatAt = parseTimestamp(now, 'Workflow runner authority heartbeat time');
      const current = this.get(workspace);
      if (!current || current.owner !== input.owner) {
        throw new Error(`Workflow runner authority for ${workspace} is not held by ${input.owner}`);
      }
      const currentExpiry = Date.parse(current.leaseExpiresAt);
      if (!Number.isFinite(currentExpiry) || currentExpiry <= heartbeatAt) {
        throw new Error(`Workflow runner authority for ${workspace} has expired`);
      }
      const leaseExpiresAt = new Date(heartbeatAt + input.leaseMs).toISOString();
      this.core.db.prepare(`
        UPDATE workflow_runner_authorities
        SET lease_expires_at = ?, updated_at = ?
        WHERE workspace = ? AND owner = ?
      `).run(leaseExpiresAt, now, workspace, input.owner);
      return this.get(workspace)!;
    });
  }

  release(input: ReleaseWorkflowRunnerAuthorityInput): boolean {
    const workspace = canonicalWorkspace(input.workspace);
    if (!input.owner.trim()) throw new Error('Workflow runner authority owner is required');
    const result = this.core.db.prepare(`
      DELETE FROM workflow_runner_authorities WHERE workspace = ? AND owner = ?
    `).run(workspace, input.owner);
    return result.changes > 0;
  }
}
