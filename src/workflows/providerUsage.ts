import type { AttemptUsage } from './domain.js';

export interface StructuredProviderResult {
  readonly text: string;
  readonly sessionId?: string;
  readonly usage?: AttemptUsage;
}

/** A provider completed unsuccessfully but still emitted authoritative metadata. */
export class ProviderExecutionError extends Error {
  constructor(
    message: string,
    public readonly details: {
      readonly sessionId?: string;
      readonly usage?: AttemptUsage;
    } = {},
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ProviderExecutionError';
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function optionalUsage(input: {
  estimatedCostUsd?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}): AttemptUsage | undefined {
  return Object.values(input).some(value => value !== undefined) ? input : undefined;
}

function codexUsage(value: unknown): AttemptUsage | undefined {
  const reported = object(value) ?? {};
  return optionalUsage({
    inputTokens: finiteNonNegative(reported.input_tokens),
    cachedInputTokens: finiteNonNegative(reported.cached_input_tokens),
    outputTokens: finiteNonNegative(reported.output_tokens),
    reasoningOutputTokens: finiteNonNegative(reported.reasoning_output_tokens),
  });
}

function claudeUsage(result: Record<string, unknown>): AttemptUsage | undefined {
  const reported = object(result.usage) ?? {};
  const uncachedInput = finiteNonNegative(reported.input_tokens);
  const cachedInput = finiteNonNegative(reported.cache_read_input_tokens);
  const cacheCreationInput = finiteNonNegative(reported.cache_creation_input_tokens);
  return optionalUsage({
    estimatedCostUsd: finiteNonNegative(result.total_cost_usd),
    // Anthropic reports these as disjoint categories. Normalize them once here;
    // downstream budgets and UI can compare providers without guessing.
    inputTokens: uncachedInput === undefined
      ? undefined
      : uncachedInput + (cachedInput ?? 0) + (cacheCreationInput ?? 0),
    cachedInputTokens: cachedInput,
    cacheCreationInputTokens: cacheCreationInput,
    outputTokens: finiteNonNegative(reported.output_tokens),
  });
}

function parseJson(value: string, provider: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${provider} returned invalid structured output`);
  }
}

/** Parse the documented `codex exec --json` JSONL event stream. */
export function parseCodexJsonl(source: string): StructuredProviderResult {
  let text: string | undefined;
  let sessionId: string | undefined;
  let usage: AttemptUsage | undefined;
  let completed = false;
  let failed = false;

  for (const line of source.split(/\r?\n/).filter(value => value.trim())) {
    const event = object(parseJson(line, 'Codex'));
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      sessionId = event.thread_id;
    }
    if (event.type === 'item.completed') {
      const item = object(event.item);
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        text = item.text;
      }
    }
    if (event.type === 'turn.completed') {
      completed = true;
      usage = codexUsage(event.usage);
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      failed = true;
      usage = codexUsage(event.usage) ?? usage;
    }
  }

  if (failed) {
    throw new ProviderExecutionError(
      'Codex reported a failed structured turn',
      { ...(sessionId ? { sessionId } : {}), ...(usage ? { usage } : {}) },
    );
  }

  if (!completed || text === undefined) {
    throw new Error('Codex structured output ended without a completed turn and final message');
  }
  return { text, ...(sessionId ? { sessionId } : {}), ...(usage ? { usage } : {}) };
}

/** Parse one `claude --output-format json` result without estimating missing data. */
export function parseClaudeJson(source: string): StructuredProviderResult {
  const result = object(parseJson(source, 'Claude'));
  if (!result || result.type !== 'result') {
    throw new Error('Claude returned an invalid structured result');
  }
  const sessionId = typeof result.session_id === 'string' ? result.session_id : undefined;
  const usage = claudeUsage(result);
  if (result.subtype !== 'success' || result.is_error === true) {
    throw new ProviderExecutionError(
      'Claude reported a failed structured result',
      { ...(sessionId ? { sessionId } : {}), ...(usage ? { usage } : {}) },
    );
  }
  if (typeof result.result !== 'string') {
    throw new Error('Claude structured output did not contain a final result');
  }
  return {
    text: result.result,
    ...(sessionId ? { sessionId } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** Preserve usage/session metadata when a CLI exits non-zero after emitting JSON. */
export function enrichProviderCommandError(
  error: unknown,
  source: string | undefined,
  parser: (value: string) => StructuredProviderResult,
): unknown {
  if (!source?.trim()) return error;
  try {
    const parsed = parser(source);
    if (!parsed.usage && !parsed.sessionId) return error;
    return new ProviderExecutionError(
      error instanceof Error ? error.message : 'Provider command failed',
      {
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
        ...(parsed.usage ? { usage: parsed.usage } : {}),
      },
      error,
    );
  } catch (structuredError) {
    return structuredError instanceof ProviderExecutionError ? structuredError : error;
  }
}
