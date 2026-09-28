import type { EnrichmentEntry, GeneratedCatalog, GeneratedTier, ModelTier } from './types.js';

export function heuristicTier(modelId: string, cliName: string): ModelTier {
  const lower = modelId.toLowerCase();
  const segments = new Set(lower.split('-'));
  if (['mini', 'lite', 'haiku', 'small', 'nano'].some(part => segments.has(part))) return 'fast';
  if (['opus', 'pro', 'max', 'ultra'].some(part => segments.has(part))) return 'powerful';
  if (cliName === 'claude' && segments.has('sonnet')) return 'balanced';
  if (cliName === 'codex') {
    if (segments.has('codex') && !segments.has('mini') && !segments.has('max')) return 'balanced';
    if (lower.startsWith('gpt-') && !segments.has('codex')) return 'powerful';
  }
  return 'balanced';
}

export function assignTiers(
  modelIds: string[],
  enrichment: EnrichmentEntry[] | null,
  previousCatalog: GeneratedCatalog | null,
  cliName: string,
): GeneratedCatalog {
  const enrichmentMap = new Map(enrichment?.map(entry => [entry.id, entry]) ?? []);
  const previousTierMap = new Map<string, ModelTier>();
  for (const tier of previousCatalog?.tiers ?? []) {
    for (const id of tier.models) previousTierMap.set(id, tier.tier);
  }

  const tierBuckets: Record<ModelTier, string[]> = {
    fast: [],
    balanced: [],
    powerful: [],
  };
  for (const id of modelIds) {
    const enriched = enrichmentMap.get(id);
    const previousTier = previousTierMap.get(id);
    const tier = enriched?.tier ?? previousTier ?? heuristicTier(id, cliName);
    const source = enriched ? 'enrichment' : previousTier ? 'previous-catalog' : 'heuristic';
    tierBuckets[tier].push(id);
    console.log(`    ${id} -> ${tier} (${source})`);
  }

  const tierOrder: ModelTier[] = ['fast', 'balanced', 'powerful'];
  const tiers: GeneratedTier[] = [];
  for (const tier of tierOrder) {
    if (tierBuckets[tier].length > 0) tiers.push({ tier, models: tierBuckets[tier].sort() });
  }
  return { cli: cliName, tiers };
}

export function getModelSets(
  catalogs: Record<string, GeneratedCatalog>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const cli of Object.keys(catalogs).sort()) {
    result[cli] = [...new Set(catalogs[cli].tiers.flatMap(tier => tier.models))].sort();
  }
  return result;
}
