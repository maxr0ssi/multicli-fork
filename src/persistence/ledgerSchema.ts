import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openLedgerDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ':memory:') {
    const directory = path.dirname(databasePath);
    const directoryExisted = fs.existsSync(directory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!directoryExisted) fs.chmodSync(directory, 0o700);
  }

  const database = new DatabaseSync(databasePath);
  if (databasePath !== ':memory:') fs.chmodSync(databasePath, 0o600);
  database.exec('PRAGMA busy_timeout = 5000;');
  migrate(database);
  return database;
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_revisions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workflow_id, content_hash)
    );
    CREATE TABLE IF NOT EXISTS workflow_drafts (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      definition_json TEXT NOT NULL,
      proposed_run_input_json TEXT,
      base_revision_id TEXT REFERENCES workflow_revisions(id),
      published_revision_id TEXT REFERENCES workflow_revisions(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_drafts_updated_at_idx
    ON workflow_drafts(updated_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
      parent_run_id TEXT REFERENCES runs(id),
      workspace TEXT,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_sequence INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS runs_updated_at_idx ON runs(updated_at DESC);
    CREATE TABLE IF NOT EXISTS workflow_runner_authorities (
      workspace TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_runner_authorities_expiry_idx
    ON workflow_runner_authorities(lease_expires_at);
    CREATE TABLE IF NOT EXISTS run_events (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT,
      PRIMARY KEY(run_id, sequence),
      UNIQUE(run_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS node_attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      lease_owner TEXT,
      lease_expires_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      output_artifact_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(run_id, node_id, attempt_number)
    );
    CREATE INDEX IF NOT EXISTS node_attempts_lease_idx
    ON node_attempts(status, lease_expires_at);
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_attempt_id TEXT,
      action_hash TEXT NOT NULL,
      risk TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      expires_at TEXT,
      decision_by TEXT
    );
    CREATE INDEX IF NOT EXISTS approvals_pending_idx ON approvals(status, requested_at);
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_attempt_id TEXT,
      content_hash TEXT NOT NULL,
      media_type TEXT NOT NULL,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts(run_id, created_at);
    CREATE TABLE IF NOT EXISTS goal_sessions (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id),
      workflow_revision_id TEXT REFERENCES workflow_revisions(id),
      profile_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_effort TEXT,
      workspace_access TEXT NOT NULL,
      selection_policy TEXT NOT NULL,
      enable_subagents INTEGER NOT NULL DEFAULT 0,
      cwd TEXT NOT NULL,
      native_session_id TEXT,
      status TEXT NOT NULL,
      turn_state TEXT NOT NULL,
      turn_count INTEGER NOT NULL DEFAULT 0,
      goal_artifact_id TEXT NOT NULL,
      last_instruction_artifact_id TEXT,
      last_reply_artifact_id TEXT,
      turn_owner TEXT,
      turn_lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS goal_sessions_run_idx
    ON goal_sessions(run_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS goal_sessions_turn_lease_idx
    ON goal_sessions(turn_state, turn_lease_expires_at);
    CREATE TABLE IF NOT EXISTS goal_session_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES goal_sessions(id) ON DELETE CASCADE,
      turn_number INTEGER,
      kind TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      media_type TEXT NOT NULL,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS goal_session_artifacts_session_idx
    ON goal_session_artifacts(session_id, created_at, id);
    INSERT OR IGNORE INTO schema_migrations(version, applied_at)
    VALUES (1, datetime('now'));
    INSERT OR IGNORE INTO schema_migrations(version, applied_at)
    VALUES (2, datetime('now'));
    INSERT OR IGNORE INTO schema_migrations(version, applied_at)
    VALUES (3, datetime('now'));
  `);
  const goalSessionColumns = database.prepare('PRAGMA table_info(goal_sessions)').all() as
    Array<Record<string, unknown>>;
  if (!goalSessionColumns.some(column => column.name === 'enable_subagents')) {
    database.exec(`
      ALTER TABLE goal_sessions
      ADD COLUMN enable_subagents INTEGER NOT NULL DEFAULT 0;
    `);
  }
  const workflowDraftColumns = database.prepare('PRAGMA table_info(workflow_drafts)').all() as
    Array<Record<string, unknown>>;
  if (!workflowDraftColumns.some(column => column.name === 'base_revision_id')) {
    database.exec(`
      ALTER TABLE workflow_drafts
      ADD COLUMN base_revision_id TEXT REFERENCES workflow_revisions(id);
    `);
  }
  if (!workflowDraftColumns.some(column => column.name === 'proposed_run_input_json')) {
    database.exec('ALTER TABLE workflow_drafts ADD COLUMN proposed_run_input_json TEXT;');
  }
  const runColumns = database.prepare('PRAGMA table_info(runs)').all() as
    Array<Record<string, unknown>>;
  if (!runColumns.some(column => column.name === 'workspace')) {
    database.exec('ALTER TABLE runs ADD COLUMN workspace TEXT;');
  }
  database.exec(`
    INSERT OR IGNORE INTO schema_migrations(version, applied_at)
    VALUES (4, datetime('now'));
    UPDATE approvals
    SET status = 'expired',
        resolved_at = COALESCE(resolved_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE status = 'pending'
      AND run_id IN (
        SELECT id FROM runs WHERE status IN ('completed', 'failed', 'cancelled')
      );
    INSERT OR IGNORE INTO schema_migrations(version, applied_at)
    VALUES (5, datetime('now'));
    INSERT OR IGNORE INTO schema_migrations(version, applied_at)
    VALUES (6, datetime('now'));
    INSERT OR IGNORE INTO schema_migrations(version, applied_at)
    VALUES (7, datetime('now'));
  `);
}
