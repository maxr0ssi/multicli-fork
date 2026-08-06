import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Maps a multicli conversation handle to the native session a backend CLI
 * already keeps on disk, so consecutive tool calls continue one conversation
 * instead of starting a fresh process with no memory.
 *
 * Only the mapping lives here. Prompts and replies are never stored: the CLIs
 * own their own transcripts and their own retention.
 */

const CONVERSATION_DIR = path.join(os.homedir(), '.multicli', 'conversations');

// Server-minted handles. Every filesystem operation validates against this
// before the id reaches a path, because the id is interpolated into one and an
// unvalidated id is an arbitrary file read/delete primitive.
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{16}$/;

// Both CLIs identify sessions by UUID. This gate is load-bearing for codex:
// `codex exec resume` treats a non-UUID argument as a thread name and, on a
// miss, silently starts a brand new paid session instead of failing.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CONVERSATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 200;
const LOCK_STALE_MS = 20 * 60 * 1000;

export type ConversationCli = 'codex' | 'claude';

export interface ConversationRecord {
  id: string;
  cli: ConversationCli;
  nativeSessionId: string;
  cwd: string;
  model: string;
  /** Pinned at turn 1. A handle must never become a privilege-escalation path. */
  sandbox: string;
  turns: number;
  createdAt: number;
  updatedAt: number;
}

export function isValidConversationId(id: unknown): id is string {
  return typeof id === 'string' && CONVERSATION_ID_PATTERN.test(id);
}

export function isValidNativeSessionId(id: unknown): id is string {
  return typeof id === 'string' && UUID_PATTERN.test(id);
}

export function newConversationId(): string {
  return randomBytes(8).toString('hex');
}

/** Resolve `<id>.json`, refusing anything that escapes the conversation dir. */
function conversationPath(id: string): string {
  if (!isValidConversationId(id)) {
    throw new Error(`Invalid conversation id: ${JSON.stringify(id)}`);
  }

  const filePath = path.join(CONVERSATION_DIR, `${id}.json`);
  if (path.dirname(path.resolve(filePath)) !== path.resolve(CONVERSATION_DIR)) {
    throw new Error(`Refusing to escape conversation directory: ${id}`);
  }

  return filePath;
}

function lockPath(id: string): string {
  return `${conversationPath(id)}.lock`;
}

function ensureDir(): void {
  fs.mkdirSync(CONVERSATION_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Every field is re-validated on read: `cwd` is handed to spawn and `cli`
 * selects an execution path, so a corrupt or hand-edited record must fail
 * closed rather than steer either one.
 */
function parseRecord(raw: unknown, id: string): ConversationRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (r.cli !== 'codex' && r.cli !== 'claude') return null;
  if (!isValidNativeSessionId(r.nativeSessionId)) return null;
  if (typeof r.cwd !== 'string' || !path.isAbsolute(r.cwd)) return null;
  if (typeof r.model !== 'string' || !r.model) return null;
  if (typeof r.sandbox !== 'string' || !r.sandbox) return null;

  return {
    id,
    cli: r.cli,
    nativeSessionId: r.nativeSessionId,
    cwd: r.cwd,
    model: r.model,
    sandbox: r.sandbox,
    turns: typeof r.turns === 'number' ? r.turns : 0,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
  };
}

export function readConversation(id: string): ConversationRecord | null {
  if (!isValidConversationId(id)) return null;

  try {
    const contents = fs.readFileSync(conversationPath(id), 'utf-8');
    return parseRecord(JSON.parse(contents), id);
  } catch {
    // Missing or unreadable is simply "no such conversation". Unlike the chunk
    // cache, a failed read never deletes the file.
    return null;
  }
}

export function writeConversation(record: ConversationRecord): void {
  ensureDir();
  const filePath = conversationPath(record.id);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), { mode: 0o600 });
  sweep(record.id);
}

export function deleteConversation(id: string): boolean {
  try {
    fs.unlinkSync(conversationPath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Serialize turns per conversation. Codex applies no locking of its own: two
 * concurrent resumes of one session both append to the same rollout, branching
 * from the same parent state and losing a turn.
 */
export function acquireTurnLock(id: string): boolean {
  ensureDir();
  const lock = lockPath(id);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lock, String(Date.now()), { flag: 'wx', mode: 0o600 });
      return true;
    } catch {
      let age: number;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        // Released between the failed write and the stat: retry the acquire.
        continue;
      }

      if (age < LOCK_STALE_MS) return false;

      try {
        fs.unlinkSync(lock);
      } catch {
        return false;
      }
    }
  }

  return false;
}

export function releaseTurnLock(id: string): void {
  try {
    fs.unlinkSync(lockPath(id));
  } catch {
    // Already gone.
  }
}

function isLocked(id: string): boolean {
  try {
    return Date.now() - fs.statSync(lockPath(id)).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Drop expired records, oldest first, never touching a turn in flight. */
function sweep(keepId: string): void {
  let entries: { id: string; updatedAt: number }[];

  try {
    entries = fs
      .readdirSync(CONVERSATION_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter(isValidConversationId)
      .map((id) => ({ id, updatedAt: readConversation(id)?.updatedAt ?? 0 }));
  } catch {
    return;
  }

  const now = Date.now();
  const expired = entries.filter((e) => now - e.updatedAt > CONVERSATION_TTL_MS);

  const overflow = entries
    .filter((e) => !expired.includes(e))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, Math.max(0, entries.length - expired.length - MAX_CONVERSATIONS));

  for (const { id } of [...expired, ...overflow]) {
    if (id === keepId || isLocked(id)) continue;
    deleteConversation(id);
  }
}
