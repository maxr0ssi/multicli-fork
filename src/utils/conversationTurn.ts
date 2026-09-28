import { randomUUID } from 'node:crypto';
import {
  ConversationCli,
  acquireTurnLock,
  deleteConversation,
  isValidConversationId,
  newConversationId,
  readConversation,
  releaseTurnLock,
  writeConversation,
} from './conversationStore.js';

/** Sentinel the calling model passes to open a conversation. */
export const NEW_CONVERSATION = 'new';
export const STATELESS_CONVERSATION = 'none';

// A conversation is the one place turns accumulate without a human in the loop,
// so it carries its own ceiling: an orchestrator that loops on a goal cannot
// spend the subscription indefinitely without the cap being raised on purpose.
const DEFAULT_MAX_TURNS = 50;

function maxTurns(): number {
  const parsed = Number.parseInt(process.env.MULTICLI_MAX_TURNS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TURNS;
}

export interface TurnResult {
  text: string;
  sessionId?: string;
}

export interface TurnRequest {
  cli: ConversationCli;
  conversationId?: string;
  model: string;
  sandbox: string;
  cwd: string;
  /** True when the CLI accepts a caller-chosen session id (claude). */
  presetSessionId: boolean;
  run: (ids: {
    startSessionId?: string;
    resumeSessionId?: string;
  }) => Promise<TurnResult>;
}

// Both CLIs report an unresumable session on stdout, and commandExecutor's
// error message carries only stderr, which for claude is always permission
// warnings. Match the whole error object, not just its message.
const STALE_SESSION_PATTERN =
  /no rollout found for thread id|No conversation found with session ID/i;

function looksStale(error: unknown): boolean {
  const err = error as { message?: string; details?: { stdout?: string; stderr?: string } };
  return STALE_SESSION_PATTERN.test(
    `${err?.message ?? ''}\n${err?.details?.stdout ?? ''}\n${err?.details?.stderr ?? ''}`,
  );
}

function handleFooter(id: string, turns: number): string {
  return `\n\n---\nConversation handle: ${id} (turn ${turns}). Pass conversationId: "${id}" to continue it.`;
}

/**
 * Runs one persistent turn by default, or a stateless turn when explicitly
 * requested with "none". Returns the reply with the handle appended so the
 * calling model can continue the thread.
 */
export async function runConversationalTurn(req: TurnRequest): Promise<string> {
  const { cli, conversationId = NEW_CONVERSATION, model, sandbox, cwd, presetSessionId, run } = req;

  if (conversationId === STATELESS_CONVERSATION) {
    const { text } = await run({});
    return text;
  }

  if (conversationId === NEW_CONVERSATION) {
    const startSessionId = presetSessionId ? randomUUID() : undefined;
    const { text, sessionId } = await run({ startSessionId });

    if (!sessionId) {
      return `${text}\n\n---\nNote: no session id was captured, so this turn could not be saved as a conversation.`;
    }

    const id = newConversationId();
    const now = Date.now();
    writeConversation({
      id, cli, nativeSessionId: sessionId, cwd, model, sandbox,
      turns: 1, createdAt: now, updatedAt: now,
    });

    return text + handleFooter(id, 1);
  }

  if (!isValidConversationId(conversationId)) {
    throw new Error(
      `Invalid conversationId ${JSON.stringify(conversationId)}. Use "new" to start a conversation, ` +
        '"none" for a one-shot call, or a 16-character handle returned by an earlier call.',
    );
  }

  const record = readConversation(conversationId);
  if (!record) {
    throw new Error(
      `Unknown conversation ${conversationId}. It may have expired. Use conversationId: "new" to start again.`,
    );
  }

  if (record.cli !== cli) {
    throw new Error(
      `Conversation ${conversationId} belongs to ${record.cli}, not ${cli}. Each conversation stays with one CLI.`,
    );
  }

  // A resumed turn must not reach outside the directory the conversation was
  // opened in, nor widen its sandbox: a handle is not an escalation path.
  if (record.cwd !== cwd) {
    throw new Error(
      `Conversation ${conversationId} was opened in ${record.cwd} but this call is running in ${cwd}. ` +
        'Start a new conversation from this directory.',
    );
  }

  if (record.sandbox !== sandbox) {
    throw new Error(
      `Conversation ${conversationId} is pinned to sandbox "${record.sandbox}" and cannot switch to "${sandbox}". ` +
        'Start a new conversation if different access is required.',
    );
  }

  if (record.turns >= maxTurns()) {
    throw new Error(
      `Conversation ${conversationId} has reached its turn budget (${record.turns}/${maxTurns()}). ` +
        'Start a new conversation, or raise MULTICLI_MAX_TURNS if this run genuinely needs more.',
    );
  }

  if (record.model !== model) {
    throw new Error(
      `Conversation ${conversationId} is pinned to model "${record.model}" and cannot switch to "${model}".`,
    );
  }

  // Codex applies no locking of its own: two concurrent resumes both append to
  // the same rollout and one turn is lost.
  if (!acquireTurnLock(conversationId)) {
    throw new Error(
      `Conversation ${conversationId} already has a turn in flight. Wait for it to finish.`,
    );
  }

  try {
    const { text } = await run({ resumeSessionId: record.nativeSessionId });

    writeConversation({
      ...record,
      turns: record.turns + 1,
      updatedAt: Date.now(),
    });

    return text + handleFooter(conversationId, record.turns + 1);
  } catch (error) {
    if (looksStale(error)) {
      deleteConversation(conversationId);
      throw new Error(
        `Conversation ${conversationId} is no longer available in ${cli} and has been forgotten. ` +
          'Use conversationId: "new" to start again.',
      );
    }
    throw error;
  } finally {
    releaseTurnLock(conversationId);
  }
}
