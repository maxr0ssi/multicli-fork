import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  readConversation: vi.fn(),
  writeConversation: vi.fn(),
  acquireTurnLock: vi.fn(() => true),
  releaseTurnLock: vi.fn(),
  deleteConversation: vi.fn(),
}));
vi.mock('../../src/utils/conversationStore.js', () => ({
  ...store,
  newConversationId: () => '0123456789abcdef',
  isValidConversationId: (id: string) => /^[0-9a-f]{16}$/.test(id),
}));

const claude = vi.hoisted(() => vi.fn());
vi.mock('../../src/utils/claudeExecutor.js', () => ({ executeClaudeCLI: claude }));
import { askClaudeTool } from '../../src/tools/ask-claude.tool.js';

import { runConversationalTurn, type TurnRequest } from '../../src/utils/conversationTurn.js';

const sessionId = '11111111-2222-3333-4444-555555555555';
const request = (overrides: Partial<TurnRequest> = {}): TurnRequest => ({
  cli: 'codex', model: 'test-model', sandbox: 'read-only', cwd: '/workspace',
  presetSessionId: false,
  run: vi.fn().mockResolvedValue({ text: 'answer', sessionId }),
  ...overrides,
});

beforeEach(() => vi.clearAllMocks());

describe('persistent conversation defaults', () => {
  it('pins the actual Claude permission mode and rejects changes before resuming', async () => {
    claude.mockResolvedValue({ text: 'answer', sessionId });
    await askClaudeTool.execute({ prompt: 'Review', model: 'test-model' }, { cwd: '/workspace' });
    const record = store.writeConversation.mock.calls[0][0];
    expect(record.sandbox).toBe('default');
    expect(claude.mock.calls[0][2]).toBe('default');
    store.readConversation.mockReturnValue(record);
    await expect(askClaudeTool.execute({
      prompt: 'Edit', model: 'test-model', conversationId: record.id, permissionMode: 'acceptEdits',
    }, { cwd: '/workspace' })).rejects.toThrow('cannot switch');
    expect(claude).toHaveBeenCalledOnce();
  });

  it.each(['codex', 'claude'] as const)('saves an omitted handle for %s and resumes its native session', async cli => {
    const first = request({ cli, presetSessionId: cli === 'claude' });
    expect(await runConversationalTurn(first)).toContain('Conversation handle: 0123456789abcdef (turn 1)');
    expect(first.run).toHaveBeenCalledWith({ startSessionId: cli === 'claude' ? expect.any(String) : undefined });
    const record = store.writeConversation.mock.calls[0][0];
    expect(record).toMatchObject({ cli, nativeSessionId: sessionId, turns: 1, cwd: '/workspace' });
    store.readConversation.mockReturnValue(record);
    const next = request({ cli, conversationId: record.id });
    expect(await runConversationalTurn(next)).toContain('(turn 2)');
    expect(next.run).toHaveBeenCalledWith({ resumeSessionId: sessionId });
    expect(store.releaseTurnLock).toHaveBeenCalledWith(record.id);
  });

  it('keeps explicit one-shot calls out of the conversation store', async () => {
    const turn = request({ conversationId: 'none' });
    expect(await runConversationalTurn(turn)).toBe('answer');
    expect(turn.run).toHaveBeenCalledWith({});
    expect(store.writeConversation).not.toHaveBeenCalled();
  });

  it('still accepts an explicit new conversation', async () => {
    expect(await runConversationalTurn(request({ conversationId: 'new' }))).toContain('Conversation handle:');
    expect(store.writeConversation).toHaveBeenCalledOnce();
  });

  it('reports a missing native session instead of claiming persistence', async () => {
    expect(await runConversationalTurn(request({ run: async () => ({ text: 'answer' }) }))).toContain('could not be saved');
    expect(store.writeConversation).not.toHaveBeenCalled();
  });

  it.each([
    { cli: 'claude' }, { model: 'other-model' }, { cwd: '/other' }, { sandbox: 'workspace-write' },
  ] as Partial<TurnRequest>[])('rejects identity drift before executing: %j', async drift => {
    store.readConversation.mockReturnValue({
      id: '0123456789abcdef', cli: 'codex', model: 'test-model', cwd: '/workspace',
      sandbox: 'read-only', turns: 1, nativeSessionId: sessionId,
    });
    const turn = request({ conversationId: '0123456789abcdef', ...drift });
    await expect(runConversationalTurn(turn)).rejects.toThrow();
    expect(turn.run).not.toHaveBeenCalled();
  });
});
