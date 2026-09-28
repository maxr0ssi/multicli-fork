import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  acquireTurnLock,
  deleteConversation,
  isValidConversationId,
  isValidNativeSessionId,
  newConversationId,
  readConversation,
  releaseTurnLock,
  writeConversation,
} from '../../src/utils/conversationStore.js';

const CONVERSATION_DIR = path.join(os.homedir(), '.multicli', 'conversations');

function makeRecord(id: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id,
    cli: 'codex' as const,
    nativeSessionId: '019fd6c2-c155-7ed0-937d-4cbe925c0ee8',
    cwd: '/private/tmp',
    model: 'gpt-5.6-sol',
    sandbox: 'read-only',
    turns: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('conversationStore', () => {
  const created: string[] = [];

  function track(id: string): string {
    created.push(id);
    return id;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const id of created.splice(0)) {
      deleteConversation(id);
      releaseTurnLock(id);
    }
  });

  describe('id validation', () => {
    it('mints 16-char hex ids that validate', () => {
      const id = newConversationId();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(isValidConversationId(id)).toBe(true);
    });

    it('rejects traversal and malformed ids', () => {
      for (const bad of [
        '../../../etc/passwd',
        'a/b',
        'ABCDEF0123456789',
        'short',
        '0123456789abcdef0',
        '',
        null,
        undefined,
      ]) {
        expect(isValidConversationId(bad)).toBe(false);
      }
    });

    it('never reads or deletes through a traversal id', () => {
      const victim = path.join(os.tmpdir(), 'conv-victim.json');
      fs.writeFileSync(victim, 'not json');

      const traversal = path.relative(CONVERSATION_DIR, victim).replace(/\.json$/, '');
      expect(readConversation(traversal)).toBeNull();
      expect(deleteConversation(traversal)).toBe(false);

      expect(fs.existsSync(victim)).toBe(true);
      fs.unlinkSync(victim);
    });

    it('only accepts UUID native session ids', () => {
      expect(isValidNativeSessionId('019fd6c2-c155-7ed0-937d-4cbe925c0ee8')).toBe(true);
      // Codex silently starts a new paid session when handed a non-UUID.
      expect(isValidNativeSessionId('not-a-real-uuid')).toBe(false);
      expect(isValidNativeSessionId('019fd6c2')).toBe(false);
    });
  });

  describe('round trip', () => {
    it('writes and reads a record', () => {
      const id = track(newConversationId());
      writeConversation(makeRecord(id));

      const got = readConversation(id);
      expect(got?.nativeSessionId).toBe('019fd6c2-c155-7ed0-937d-4cbe925c0ee8');
      expect(got?.cli).toBe('codex');
      expect(got?.sandbox).toBe('read-only');
    });

    it('stores the record without world-readable permissions', () => {
      const id = track(newConversationId());
      writeConversation(makeRecord(id));

      const mode = fs.statSync(path.join(CONVERSATION_DIR, `${id}.json`)).mode & 0o077;
      expect(mode).toBe(0);
    });

    it('returns null for an unknown conversation', () => {
      expect(readConversation('0123456789abcdef')).toBeNull();
    });
  });

  describe('record validation on read', () => {
    it('rejects a record whose cwd is not absolute', () => {
      const id = track(newConversationId());
      writeConversation(makeRecord(id));
      fs.writeFileSync(
        path.join(CONVERSATION_DIR, `${id}.json`),
        JSON.stringify(makeRecord(id, { cwd: 'relative/path' })),
      );

      // cwd is handed to spawn, so a bad one must fail closed.
      expect(readConversation(id)).toBeNull();
    });

    it('rejects a record with an unknown cli', () => {
      const id = track(newConversationId());
      writeConversation(makeRecord(id));
      fs.writeFileSync(
        path.join(CONVERSATION_DIR, `${id}.json`),
        JSON.stringify(makeRecord(id, { cli: 'evil' })),
      );

      expect(readConversation(id)).toBeNull();
    });

    it('rejects a record whose native session id is not a UUID', () => {
      const id = track(newConversationId());
      writeConversation(makeRecord(id));
      fs.writeFileSync(
        path.join(CONVERSATION_DIR, `${id}.json`),
        JSON.stringify(makeRecord(id, { nativeSessionId: 'thread-name' })),
      );

      expect(readConversation(id)).toBeNull();
    });
  });

  describe('turn lock', () => {
    it('never steals a long-running turn from a live process', () => {
      const id = track(newConversationId());
      expect(acquireTurnLock(id)).toBe(true);
      const lock = path.join(CONVERSATION_DIR, `${id}.json.lock`);
      const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
      fs.utimesSync(lock, old, old);
      expect(acquireTurnLock(id)).toBe(false);
    });

    it('reclaims a stale lock only after its owner has exited', () => {
      const id = track(newConversationId());
      expect(acquireTurnLock(id)).toBe(true);
      const lock = path.join(CONVERSATION_DIR, `${id}.json.lock`);
      const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
      fs.utimesSync(lock, old, old);
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('no process'), { code: 'ESRCH' });
      });
      expect(acquireTurnLock(id)).toBe(true);
    });

    it('keeps a lock when process liveness cannot be established', () => {
      const id = track(newConversationId());
      expect(acquireTurnLock(id)).toBe(true);
      const lock = path.join(CONVERSATION_DIR, `${id}.json.lock`);
      const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
      fs.utimesSync(lock, old, old);
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      });
      expect(acquireTurnLock(id)).toBe(false);
    });

    it('is exclusive while held and reusable after release', () => {
      const id = track(newConversationId());

      expect(acquireTurnLock(id)).toBe(true);
      expect(acquireTurnLock(id)).toBe(false);

      releaseTurnLock(id);
      expect(acquireTurnLock(id)).toBe(true);
      releaseTurnLock(id);
    });
  });
});
