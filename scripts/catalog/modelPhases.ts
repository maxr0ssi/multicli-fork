import { execFileSync } from 'node:child_process';

import type {
  CatalogCLIConfig,
  CatalogRefreshOptions,
  EnrichmentEntry,
  OptionalModelPhaseResult,
  StructuredCommand,
} from './types.js';

const VALID_TIERS = new Set(['fast', 'balanced', 'powerful']);
const TRANSIENT_PATTERNS = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|timeout|rate.?limit|429|503|502/i;
const PROBE_MAX_RETRIES = 3;

interface EnrichmentResponse {
  models: EnrichmentEntry[];
}

function executeModelCommand(command: StructuredCommand, timeout: number): string {
  return execFileSync(command.executable, [...command.argv], {
    encoding: 'utf-8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
}

export function buildClaudeModelCommand(model: string, prompt: string): StructuredCommand {
  return {
    executable: 'claude',
    argv: ['--print', '--output-format', 'text', '--model', model, prompt],
  };
}

export function buildCodexModelCommand(model: string, prompt: string): StructuredCommand {
  return {
    executable: 'codex',
    argv: [
      'exec',
      prompt,
      '--skip-git-repo-check',
      '--color',
      'never',
      '--sandbox',
      'read-only',
      '-m',
      model,
    ],
  };
}

export function pickEnrichmentModel(modelIds: string[], pattern: RegExp): string {
  const match = modelIds.find(id => pattern.test(id));
  return match ?? modelIds[0];
}

export function probeModels(config: CatalogCLIConfig, modelIds: string[]): string[] {
  console.log(`  [probe] Testing ${modelIds.length} models for availability...`);
  const valid: string[] = [];

  for (const id of modelIds) {
    const command = config.buildModelCommand(id, 'respond with OK');
    let succeeded = false;

    for (let attempt = 1; attempt <= PROBE_MAX_RETRIES; attempt += 1) {
      try {
        executeModelCommand(command, 30_000);
        succeeded = true;
        break;
      } catch (error) {
        const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
        if (attempt < PROBE_MAX_RETRIES && TRANSIENT_PATTERNS.test(reason)) {
          console.warn(`    ${id}: transient failure (attempt ${attempt}/${PROBE_MAX_RETRIES}) — ${reason}`);
          continue;
        }
        console.warn(`    ${id}: unavailable — ${reason}`);
        break;
      }
    }

    if (succeeded) {
      valid.push(id);
      console.log(`    ${id}: available`);
    }
  }

  console.log(`  [probe] ${valid.length}/${modelIds.length} models available`);
  return valid;
}

export function buildEnrichmentPrompt(cliName: string, modelIds: string[]): string {
  return `You are classifying ${cliName} models into performance tiers.

Here are the exact model IDs available in the ${cliName} CLI:
${JSON.stringify(modelIds)}

Classify EACH model into exactly one tier and respond with ONLY valid JSON (no markdown, no code fences, no explanation):

{
  "models": [
    {
      "id": "exact model ID from the list above",
      "tier": "fast | balanced | powerful",
      "displayName": "human-friendly name (e.g. 'Haiku', 'Sonnet 4', 'GPT-5.2 Codex')",
      "description": "1 sentence on strengths/when to use"
    }
  ]
}

Rules:
- You MUST classify EVERY model ID listed above. Do not skip any.
- You MUST NOT invent model IDs. Only use IDs from the list.
- Classify by relative capability: smallest/fastest -> "fast", mid-range -> "balanced", largest/most capable -> "powerful"
- Each tier should have at least one model (if 3+ models are provided)
- The "id" field must EXACTLY match one of the IDs provided above`;
}

export function enrichModels(
  config: CatalogCLIConfig,
  modelIds: string[],
): EnrichmentEntry[] | null {
  const enrichmentModel = pickEnrichmentModel(modelIds, config.fastModelPattern);
  const command = config.buildModelCommand(
    enrichmentModel,
    buildEnrichmentPrompt(config.name, modelIds),
  );
  console.log(`  [enrich] Querying ${config.name} CLI (model: ${enrichmentModel})...`);

  try {
    return validateEnrichment(executeModelCommand(command, 120_000), config.name, modelIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  [enrich] ${config.name}: CLI invocation failed — ${message}`);
    return null;
  }
}

export function runOptionalModelPhases(
  config: CatalogCLIConfig,
  modelIds: string[],
  options: Pick<CatalogRefreshOptions, 'probe' | 'enrich'>,
): OptionalModelPhaseResult {
  const validIds = options.probe ? probeModels(config, modelIds) : modelIds;
  if (!options.probe) {
    console.log('  [probe] skipped (pass --probe to opt in to model requests)');
  }
  const enrichment = options.enrich ? enrichModels(config, validIds) : null;
  if (!options.enrich) {
    console.log('  [enrich] skipped (pass --enrich to opt in to model requests)');
  }
  return { modelIds: validIds, enrichment };
}

export function validateEnrichment(
  raw: string,
  cliName: string,
  knownIds: string[],
): EnrichmentEntry[] | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: EnrichmentResponse;
  try {
    parsed = JSON.parse(cleaned) as EnrichmentResponse;
  } catch {
    console.error(`  [validate] ${cliName}: response is not valid JSON`);
    return null;
  }
  if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
    console.error(`  [validate] ${cliName}: no models array or it is empty`);
    return null;
  }

  const knownSet = new Set(knownIds);
  const valid: EnrichmentEntry[] = [];
  for (const model of parsed.models) {
    if (
      typeof model.id !== 'string'
      || typeof model.tier !== 'string'
      || !VALID_TIERS.has(model.tier)
      || typeof model.displayName !== 'string'
      || typeof model.description !== 'string'
    ) {
      console.warn(`  [validate] ${cliName}: skipping malformed entry: ${JSON.stringify(model)}`);
      continue;
    }
    if (!knownSet.has(model.id)) {
      console.warn(`  [validate] ${cliName}: rejecting invented model ID: "${model.id}"`);
      continue;
    }
    valid.push({
      id: model.id.trim(),
      tier: model.tier,
      displayName: model.displayName.trim(),
      description: model.description.trim(),
    });
  }

  if (valid.length === 0) {
    console.error(`  [validate] ${cliName}: no valid entries after validation`);
    return null;
  }
  const coveredIds = new Set(valid.map(entry => entry.id));
  if (coveredIds.size / knownIds.length < 0.5) {
    console.warn(`  [validate] ${cliName}: low coverage (${coveredIds.size}/${knownIds.length}), rejecting enrichment`);
    return null;
  }
  if (valid.length >= 3) {
    const uniqueTiers = new Set(valid.map(entry => entry.tier));
    if (uniqueTiers.size === 1) {
      console.warn(`  [validate] ${cliName}: all ${valid.length} models in same tier "${[...uniqueTiers][0]}", rejecting`);
      return null;
    }
  }

  console.log(`  [validate] ${cliName}: ${valid.length}/${knownIds.length} models classified`);
  return valid;
}
