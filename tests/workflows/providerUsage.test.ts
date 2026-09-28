import { describe, expect, it } from 'vitest';

import {
  parseClaudeJson,
  parseCodexJsonl,
  ProviderExecutionError,
} from '../../src/workflows/providerUsage.js';

describe('structured provider usage', () => {
  it('extracts only Codex final text, native id, and provider-reported tokens', () => {
    const result = parseCodexJsonl([
      JSON.stringify({ type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', output: 'private' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 12_000,
          cached_input_tokens: 9_000,
          output_tokens: 640,
          reasoning_output_tokens: 510,
        },
      }),
    ].join('\n'));

    expect(result).toEqual({
      text: 'Done.',
      sessionId: '11111111-1111-4111-8111-111111111111',
      usage: {
        inputTokens: 12_000,
        cachedInputTokens: 9_000,
        outputTokens: 640,
        reasoningOutputTokens: 510,
      },
    });
  });

  it('rejects an incomplete Codex stream rather than presenting partial data', () => {
    expect(() => parseCodexJsonl(JSON.stringify({
      type: 'item.completed', item: { type: 'agent_message', text: 'partial' },
    }))).toThrow(/without a completed turn/);
  });

  it('preserves Claude token categories and reported cost without estimates', () => {
    const result = parseClaudeJson(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Reviewed.',
      session_id: '22222222-2222-4222-8222-222222222222',
      total_cost_usd: 0.042,
      usage: {
        input_tokens: 200,
        cache_read_input_tokens: 1_500,
        cache_creation_input_tokens: 300,
        output_tokens: 90,
      },
    }));

    expect(result.usage).toEqual({
      estimatedCostUsd: 0.042,
      inputTokens: 2_000,
      cachedInputTokens: 1_500,
      cacheCreationInputTokens: 300,
      outputTokens: 90,
    });
  });

  it('preserves provider-reported usage when a Codex turn fails', () => {
    expect.assertions(2);
    try {
      parseCodexJsonl([
        JSON.stringify({ type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111' }),
        JSON.stringify({
          type: 'turn.failed',
          usage: { input_tokens: 400, cached_input_tokens: 250, output_tokens: 12 },
        }),
      ].join('\n'));
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderExecutionError);
      expect((error as ProviderExecutionError).details.usage).toEqual({
        inputTokens: 400,
        cachedInputTokens: 250,
        outputTokens: 12,
      });
    }
  });

  it('preserves provider-reported usage and cost when Claude reports failure', () => {
    expect.assertions(2);
    try {
      parseClaudeJson(JSON.stringify({
        type: 'result', subtype: 'error', is_error: true, result: 'failed',
        total_cost_usd: 0.02,
        usage: { input_tokens: 50, cache_read_input_tokens: 100, output_tokens: 3 },
      }));
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderExecutionError);
      expect((error as ProviderExecutionError).details.usage).toEqual({
        estimatedCostUsd: 0.02,
        inputTokens: 150,
        cachedInputTokens: 100,
        outputTokens: 3,
      });
    }
  });

  it('leaves entirely absent Claude usage unknown', () => {
    expect(parseClaudeJson(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'Done.',
    }))).toEqual({ text: 'Done.' });
  });
});
