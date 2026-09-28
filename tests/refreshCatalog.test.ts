import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  heuristicTier,
  validateEnrichment,
  assignTiers,
  buildClaudeModelCommand,
  buildCodexModelCommand,
  buildEnrichmentPrompt,
  enrichModels,
  parseCatalogRefreshOptions,
  pickEnrichmentModel,
  probeModels,
  refreshCatalogUsage,
  runOptionalModelPhases,
  getModelSets,
} from '../scripts/refresh-catalog.js';
import type { CatalogCLIConfig, EnrichmentEntry } from '../scripts/refresh-catalog.js';

// ===========================================================================
// heuristicTier
// ===========================================================================

describe('heuristicTier', () => {
  describe('fast tier', () => {
    it('classifies haiku as fast', () => {
      expect(heuristicTier('claude-haiku-4-5-20251001', 'claude')).toBe('fast');
    });

    it('classifies mini as fast', () => {
      expect(heuristicTier('gpt-5.1-codex-mini', 'codex')).toBe('fast');
    });

    it('classifies lite as fast', () => {
      expect(heuristicTier('model-lite', 'test')).toBe('fast');
    });
  });

  describe('balanced tier', () => {
    it('classifies sonnet as balanced for claude', () => {
      expect(heuristicTier('claude-sonnet-4-6', 'claude')).toBe('balanced');
    });

    it('classifies codex (no mini/max suffix) as balanced', () => {
      expect(heuristicTier('gpt-5.2-codex', 'codex')).toBe('balanced');
    });

    it('defaults unknown models to balanced', () => {
      expect(heuristicTier('claude-mystery-9000', 'claude')).toBe('balanced');
    });
  });

  describe('powerful tier', () => {
    it('classifies opus as powerful', () => {
      expect(heuristicTier('claude-opus-4-6', 'claude')).toBe('powerful');
    });

    it('classifies pro as powerful', () => {
      expect(heuristicTier('model-pro', 'test')).toBe('powerful');
    });

    it('classifies max as powerful', () => {
      expect(heuristicTier('gpt-5.1-codex-max', 'codex')).toBe('powerful');
    });

    it('classifies plain gpt (without codex suffix) as powerful', () => {
      expect(heuristicTier('gpt-5.2', 'codex')).toBe('powerful');
    });
  });
});

// ===========================================================================
// validateEnrichment
// ===========================================================================

describe('validateEnrichment', () => {
  const knownIds = ['model-a', 'model-b', 'model-c'];

  function makeResponse(models: object[]): string {
    return JSON.stringify({ models });
  }

  it('accepts valid enrichment with all known IDs', () => {
    const raw = makeResponse([
      { id: 'model-a', tier: 'fast', displayName: 'A', description: 'fast one' },
      { id: 'model-b', tier: 'balanced', displayName: 'B', description: 'mid one' },
      { id: 'model-c', tier: 'powerful', displayName: 'C', description: 'big one' },
    ]);
    const result = validateEnrichment(raw, 'test', knownIds);
    expect(result).toHaveLength(3);
    expect(result!.map((e) => e.id)).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('rejects invented model IDs while keeping valid ones', () => {
    const raw = makeResponse([
      { id: 'model-a', tier: 'fast', displayName: 'A', description: 'fast' },
      { id: 'model-FAKE', tier: 'balanced', displayName: 'Fake', description: 'made up' },
      { id: 'model-c', tier: 'powerful', displayName: 'C', description: 'big' },
    ]);
    const result = validateEnrichment(raw, 'test', knownIds);
    expect(result).toHaveLength(2);
    expect(result!.map((e) => e.id)).toEqual(['model-a', 'model-c']);
  });

  it('rejects when all models in same tier (3+ models)', () => {
    const raw = makeResponse([
      { id: 'model-a', tier: 'balanced', displayName: 'A', description: 'd' },
      { id: 'model-b', tier: 'balanced', displayName: 'B', description: 'd' },
      { id: 'model-c', tier: 'balanced', displayName: 'C', description: 'd' },
    ]);
    expect(validateEnrichment(raw, 'test', knownIds)).toBeNull();
  });

  it('allows same tier when fewer than 3 models', () => {
    const twoIds = ['model-a', 'model-b'];
    const raw = makeResponse([
      { id: 'model-a', tier: 'fast', displayName: 'A', description: 'd' },
      { id: 'model-b', tier: 'fast', displayName: 'B', description: 'd' },
    ]);
    const result = validateEnrichment(raw, 'test', twoIds);
    expect(result).toHaveLength(2);
  });

  it('rejects when coverage below 50%', () => {
    const fiveIds = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const raw = makeResponse([
      { id: 'm1', tier: 'fast', displayName: 'M1', description: 'd' },
      { id: 'm2', tier: 'balanced', displayName: 'M2', description: 'd' },
    ]);
    expect(validateEnrichment(raw, 'test', fiveIds)).toBeNull();
  });

  it('strips markdown code fences', () => {
    const inner = makeResponse([
      { id: 'model-a', tier: 'fast', displayName: 'A', description: 'f' },
      { id: 'model-b', tier: 'powerful', displayName: 'B', description: 'p' },
    ]);
    const raw = '```json\n' + inner + '\n```';
    expect(validateEnrichment(raw, 'test', ['model-a', 'model-b'])).toHaveLength(2);
  });

  it('returns null for non-JSON', () => {
    expect(validateEnrichment('not json at all', 'test', knownIds)).toBeNull();
  });

  it('returns null for empty models array', () => {
    expect(validateEnrichment('{"models":[]}', 'test', knownIds)).toBeNull();
  });

  it('skips entries with invalid tier values', () => {
    const raw = makeResponse([
      { id: 'model-a', tier: 'fast', displayName: 'A', description: 'd' },
      { id: 'model-b', tier: 'INVALID', displayName: 'B', description: 'd' },
      { id: 'model-c', tier: 'powerful', displayName: 'C', description: 'd' },
    ]);
    const result = validateEnrichment(raw, 'test', knownIds);
    expect(result).toHaveLength(2);
  });

  it('skips entries with missing fields', () => {
    const raw = makeResponse([
      { id: 'model-a', tier: 'fast', displayName: 'A', description: 'd' },
      { id: 'model-b', tier: 'balanced' }, // missing displayName, description
      { id: 'model-c', tier: 'powerful', displayName: 'C', description: 'd' },
    ]);
    const result = validateEnrichment(raw, 'test', knownIds);
    expect(result).toHaveLength(2);
  });
});

// ===========================================================================
// assignTiers
// ===========================================================================

describe('assignTiers', () => {
  it('uses enrichment when available', () => {
    const ids = ['model-a', 'model-b'];
    const enrichment: EnrichmentEntry[] = [
      { id: 'model-a', tier: 'fast', displayName: 'A', description: 'f' },
      { id: 'model-b', tier: 'powerful', displayName: 'B', description: 'p' },
    ];
    const result = assignTiers(ids, enrichment, null, 'test');
    expect(result.cli).toBe('test');
    expect(result.tiers).toHaveLength(2);
    expect(result.tiers[0]).toEqual({ tier: 'fast', models: ['model-a'] });
    expect(result.tiers[1]).toEqual({ tier: 'powerful', models: ['model-b'] });
  });

  it('falls back to previous catalog for unenriched models', () => {
    const ids = ['model-a', 'model-b'];
    const enrichment: EnrichmentEntry[] = [
      { id: 'model-a', tier: 'fast', displayName: 'A', description: 'f' },
    ];
    const previous = {
      cli: 'test',
      tiers: [{ tier: 'powerful' as const, models: ['model-b'] }],
    };
    const result = assignTiers(ids, enrichment, previous, 'test');
    expect(result.tiers.find((t) => t.tier === 'fast')?.models).toContain('model-a');
    expect(result.tiers.find((t) => t.tier === 'powerful')?.models).toContain('model-b');
  });

  it('falls back to heuristic for completely new models', () => {
    const ids = ['claude-haiku-99'];
    const result = assignTiers(ids, null, null, 'claude');
    expect(result.tiers).toHaveLength(1);
    expect(result.tiers[0]).toEqual({ tier: 'fast', models: ['claude-haiku-99'] });
  });

  it('returns empty tiers for empty model list', () => {
    const result = assignTiers([], null, null, 'test');
    expect(result.tiers).toHaveLength(0);
  });

  it('preserves tier order (fast, balanced, powerful)', () => {
    const ids = ['claude-opus-1', 'claude-haiku-1', 'claude-sonnet-1'];
    const result = assignTiers(ids, null, null, 'claude');
    const tierNames = result.tiers.map((t) => t.tier);
    expect(tierNames).toEqual(['fast', 'balanced', 'powerful']);
  });

  it('omits empty tiers', () => {
    const ids = ['claude-haiku-1', 'claude-opus-1'];
    const result = assignTiers(ids, null, null, 'claude');
    expect(result.tiers).toHaveLength(2);
    expect(result.tiers.map((t) => t.tier)).toEqual(['fast', 'powerful']);
  });

  it('enrichment takes priority over previous catalog', () => {
    const ids = ['model-a'];
    const enrichment: EnrichmentEntry[] = [
      { id: 'model-a', tier: 'powerful', displayName: 'A', description: 'p' },
    ];
    const previous = {
      cli: 'test',
      tiers: [{ tier: 'fast' as const, models: ['model-a'] }],
    };
    const result = assignTiers(ids, enrichment, previous, 'test');
    expect(result.tiers[0]).toEqual({ tier: 'powerful', models: ['model-a'] });
  });
});

// ===========================================================================
// buildEnrichmentPrompt
// ===========================================================================

describe('buildEnrichmentPrompt', () => {
  it('includes the CLI name', () => {
    const prompt = buildEnrichmentPrompt('claude', ['claude-opus-4-6']);
    expect(prompt).toContain('claude');
  });

  it('includes all model IDs', () => {
    const ids = ['model-a', 'model-b', 'model-c'];
    const prompt = buildEnrichmentPrompt('test', ids);
    for (const id of ids) {
      expect(prompt).toContain(id);
    }
  });

  it('includes tier classification instructions', () => {
    const prompt = buildEnrichmentPrompt('test', ['m1']);
    expect(prompt).toContain('fast');
    expect(prompt).toContain('balanced');
    expect(prompt).toContain('powerful');
  });
});

// ===========================================================================
// pickEnrichmentModel
// ===========================================================================

describe('pickEnrichmentModel', () => {
  it('picks haiku for claude', () => {
    const ids = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
    expect(pickEnrichmentModel(ids, /haiku/i)).toBe('claude-haiku-4-5-20251001');
  });

  it('picks mini for codex', () => {
    const ids = ['gpt-5.2-codex', 'gpt-5.1-codex-mini', 'gpt-5.3-codex'];
    expect(pickEnrichmentModel(ids, /mini/i)).toBe('gpt-5.1-codex-mini');
  });

  it('falls back to first model if no pattern match', () => {
    const ids = ['unknown-model-a', 'unknown-model-b'];
    expect(pickEnrichmentModel(ids, /haiku/i)).toBe('unknown-model-a');
  });

  it('handles future model names gracefully', () => {
    const ids = ['claude-haiku-99-turbo', 'claude-opus-99'];
    expect(pickEnrichmentModel(ids, /haiku/i)).toBe('claude-haiku-99-turbo');
  });
});

// ===========================================================================
// probeModels
// ===========================================================================

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

describe('probeModels', () => {
  const fakeConfig: CatalogCLIConfig = {
    name: 'test',
    expectedPrefix: 'model-',
    extractScript: 'scripts/extract-test.sh',
    fastModelPattern: /mini/i,
    buildModelCommand: (model: string, prompt: string) => ({
      executable: 'test-cli',
      argv: ['-m', model, prompt],
    }),
  };

  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('returns all models when all probes succeed', () => {
    mockExecFileSync.mockReturnValue('OK');
    const result = probeModels(fakeConfig, ['model-a', 'model-b', 'model-c']);
    expect(result).toEqual(['model-a', 'model-b', 'model-c']);
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  });

  it('filters out models that fail probing with non-transient errors', () => {
    mockExecFileSync
      .mockReturnValueOnce('OK')           // model-a: success
      .mockImplementationOnce(() => { throw new Error('model not found'); }) // model-b: fail (no retry)
      .mockReturnValueOnce('OK');           // model-c: success
    const result = probeModels(fakeConfig, ['model-a', 'model-b', 'model-c']);
    expect(result).toEqual(['model-a', 'model-c']);
    // model-b should only be attempted once (non-transient error)
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  });

  it('retries on transient errors and succeeds', () => {
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('spawnSync /bin/sh ETIMEDOUT'); }) // attempt 1: timeout
      .mockImplementationOnce(() => { throw new Error('socket hang up'); })              // attempt 2: network
      .mockReturnValueOnce('OK');                                                         // attempt 3: success
    const result = probeModels(fakeConfig, ['model-a']);
    expect(result).toEqual(['model-a']);
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  });

  it('gives up after max retries on persistent transient errors', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('spawnSync /bin/sh ETIMEDOUT'); });
    const result = probeModels(fakeConfig, ['model-a']);
    expect(result).toEqual([]);
    expect(mockExecFileSync).toHaveBeenCalledTimes(3); // 3 attempts then give up
  });

  it('returns empty array when all probes fail', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('fail'); });
    const result = probeModels(fakeConfig, ['model-a', 'model-b']);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    const result = probeModels(fakeConfig, []);
    expect(result).toEqual([]);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('passes the model and prompt as separate non-shell argv entries', () => {
    mockExecFileSync.mockReturnValue('OK');
    probeModels(fakeConfig, ['model-a']);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'test-cli',
      ['-m', 'model-a', 'respond with OK'],
      expect.objectContaining({ timeout: 30_000, shell: false }),
    );
  });
});

// ===========================================================================
// model invocation safety
// ===========================================================================

describe('model invocation safety', () => {
  const fakeConfig: CatalogCLIConfig = {
    name: 'test',
    expectedPrefix: 'model-',
    extractScript: 'scripts/extract-test.sh',
    fastModelPattern: /mini/i,
    buildModelCommand: (model: string, prompt: string) => ({
      executable: 'test-cli',
      argv: ['-m', model, prompt],
    }),
  };

  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('leaves paid model phases off by default', () => {
    const options = parseCatalogRefreshOptions([]);
    const result = runOptionalModelPhases(fakeConfig, ['model-a', 'model-b'], options);

    expect(options).toEqual({ probe: false, enrich: false, help: false });
    expect(result).toEqual({ modelIds: ['model-a', 'model-b'], enrichment: null });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('requires explicit flags for probing and enrichment', () => {
    expect(parseCatalogRefreshOptions(['--probe'])).toEqual({
      probe: true,
      enrich: false,
      help: false,
    });
    expect(parseCatalogRefreshOptions(['--enrich'])).toEqual({
      probe: false,
      enrich: true,
      help: false,
    });
    expect(parseCatalogRefreshOptions(['--probe', '--enrich'])).toEqual({
      probe: true,
      enrich: true,
      help: false,
    });
    expect(() => parseCatalogRefreshOptions(['--unexpected'])).toThrow('Unknown refresh-catalog option');
  });

  it('builds Claude commands as structured argv', () => {
    const model = 'model; touch /tmp/not-executed';
    const prompt = 'classify $(whoami) && echo unsafe';
    const command = buildClaudeModelCommand(model, prompt);

    expect(command).toEqual({
      executable: 'claude',
      argv: ['--print', '--output-format', 'text', '--model', model, prompt],
    });
  });

  it('builds Codex commands as read-only structured argv without full-auto', () => {
    const command = buildCodexModelCommand('gpt-5.2-codex-mini', 'respond with OK');

    expect(command.executable).toBe('codex');
    expect(command.argv).toContain('--sandbox');
    expect(command.argv).toContain('read-only');
    expect(command.argv).not.toContain('--full-auto');
    expect(command.argv).toContain('respond with OK');
  });

  it('uses the same structured argv execution path for enrichment', () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({
      models: [
        { id: 'model-a', tier: 'fast', displayName: 'A', description: 'fast' },
        { id: 'model-b', tier: 'powerful', displayName: 'B', description: 'powerful' },
      ],
    }));

    const result = enrichModels(fakeConfig, ['model-a', 'model-b']);

    expect(result?.map((entry) => entry.id)).toEqual(['model-a', 'model-b']);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'test-cli',
      ['-m', 'model-a', expect.any(String)],
      expect.objectContaining({ timeout: 120_000, shell: false }),
    );
  });

  it('documents local-session opt-in without API-key suggestions', () => {
    const usage = refreshCatalogUsage();

    expect(usage).toContain('disabled by default');
    expect(usage).toContain('signed-in local CLI subscription');
    expect(usage).not.toContain('OPENAI_API_KEY');
    expect(usage).not.toContain('ANTHROPIC_API_KEY');
  });
});

// ===========================================================================
// getModelSets (change detection)
// ===========================================================================

describe('getModelSets', () => {
  it('returns sorted model IDs per CLI, ignoring tiers', () => {
    const cats = {
      claude: { cli: 'claude', tiers: [
        { tier: 'fast' as const, models: ['claude-haiku-4-5'] },
        { tier: 'powerful' as const, models: ['claude-opus-4-6'] },
        { tier: 'balanced' as const, models: ['claude-sonnet-4-5'] },
      ]},
    };
    expect(getModelSets(cats)).toEqual({
      claude: ['claude-haiku-4-5', 'claude-opus-4-6', 'claude-sonnet-4-5'],
    });
  });

  it('treats same models in different tiers as identical', () => {
    const catsA = {
      codex: { cli: 'codex', tiers: [
        { tier: 'fast' as const, models: ['gpt-5-codex'] },
        { tier: 'balanced' as const, models: ['gpt-5.2'] },
      ]},
    };
    const catsB = {
      codex: { cli: 'codex', tiers: [
        { tier: 'balanced' as const, models: ['gpt-5-codex', 'gpt-5.2'] },
      ]},
    };
    expect(JSON.stringify(getModelSets(catsA)))
      .toBe(JSON.stringify(getModelSets(catsB)));
  });

  it('treats same models in different order as identical', () => {
    const catsA = {
      gemini: { cli: 'gemini', tiers: [
        { tier: 'fast' as const, models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'] },
      ]},
    };
    const catsB = {
      gemini: { cli: 'gemini', tiers: [
        { tier: 'fast' as const, models: ['gemini-2.5-flash-lite', 'gemini-2.5-flash'] },
      ]},
    };
    expect(JSON.stringify(getModelSets(catsA)))
      .toBe(JSON.stringify(getModelSets(catsB)));
  });

  it('is independent of CLI key insertion order', () => {
    const catsA = {
      claude: { cli: 'claude', tiers: [{ tier: 'fast' as const, models: ['a'] }] },
      gemini: { cli: 'gemini', tiers: [{ tier: 'fast' as const, models: ['b'] }] },
    };
    const catsB = {
      gemini: { cli: 'gemini', tiers: [{ tier: 'fast' as const, models: ['b'] }] },
      claude: { cli: 'claude', tiers: [{ tier: 'fast' as const, models: ['a'] }] },
    };
    expect(JSON.stringify(getModelSets(catsA)))
      .toBe(JSON.stringify(getModelSets(catsB)));
  });

  it('deduplicates model IDs across tiers', () => {
    const cats = {
      codex: { cli: 'codex', tiers: [
        { tier: 'fast' as const, models: ['gpt-5-codex'] },
        { tier: 'balanced' as const, models: ['gpt-5-codex', 'gpt-5.2'] },
      ]},
    };
    expect(getModelSets(cats)).toEqual({
      codex: ['gpt-5-codex', 'gpt-5.2'],
    });
  });

  it('detects when a new model is added', () => {
    const old = {
      claude: { cli: 'claude', tiers: [{ tier: 'fast' as const, models: ['a'] }] },
    };
    const updated = {
      claude: { cli: 'claude', tiers: [{ tier: 'fast' as const, models: ['a', 'b'] }] },
    };
    expect(JSON.stringify(getModelSets(old)))
      .not.toBe(JSON.stringify(getModelSets(updated)));
  });

  it('detects when a model is removed', () => {
    const old = {
      claude: { cli: 'claude', tiers: [{ tier: 'fast' as const, models: ['a', 'b'] }] },
    };
    const updated = {
      claude: { cli: 'claude', tiers: [{ tier: 'fast' as const, models: ['a'] }] },
    };
    expect(JSON.stringify(getModelSets(old)))
      .not.toBe(JSON.stringify(getModelSets(updated)));
  });

  it('detects when a new CLI is added', () => {
    const old = {
      claude: { cli: 'claude', tiers: [{ tier: 'fast' as const, models: ['a'] }] },
    };
    const updated = {
      claude: { cli: 'claude', tiers: [{ tier: 'fast' as const, models: ['a'] }] },
      gemini: { cli: 'gemini', tiers: [{ tier: 'fast' as const, models: ['b'] }] },
    };
    expect(JSON.stringify(getModelSets(old)))
      .not.toBe(JSON.stringify(getModelSets(updated)));
  });
});
