#!/usr/bin/env npx tsx
/** Refreshes public CLI model metadata; model requests require explicit opt-in flags. */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildClaudeModelCommand,
  buildCodexModelCommand,
  runOptionalModelPhases,
} from './catalog/modelPhases.js';
import { assignTiers, getModelSets } from './catalog/tiers.js';
import type {
  CatalogCLIConfig,
  CatalogRefreshOptions,
  GeneratedCatalog,
  GeneratedFile,
} from './catalog/types.js';

export {
  buildClaudeModelCommand,
  buildCodexModelCommand,
  buildEnrichmentPrompt,
  enrichModels,
  pickEnrichmentModel,
  probeModels,
  runOptionalModelPhases,
  validateEnrichment,
} from './catalog/modelPhases.js';
export { assignTiers, getModelSets, heuristicTier } from './catalog/tiers.js';
export type {
  CatalogCLIConfig,
  CatalogRefreshOptions,
  EnrichmentEntry,
  OptionalModelPhaseResult,
  StructuredCommand,
} from './catalog/types.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const generatedPath = resolve(scriptDirectory, '..', 'src', 'modelCatalog.generated.json');

const CLI_CONFIGS: CatalogCLIConfig[] = [
  {
    name: 'claude',
    expectedPrefix: 'claude-',
    extractScript: 'scripts/extract-claude.sh',
    fastModelPattern: /haiku/i,
    buildModelCommand: buildClaudeModelCommand,
  },
  {
    name: 'codex',
    expectedPrefix: 'gpt-',
    extractScript: 'scripts/extract-codex.sh',
    fastModelPattern: /mini/i,
    buildModelCommand: buildCodexModelCommand,
  },
];

export function refreshCatalogUsage(): string {
  return [
    'Usage: npx tsx scripts/refresh-catalog.ts [--probe] [--enrich]',
    '',
    'Default: discover public model metadata and assign existing or heuristic tiers.',
    'Model prompts are disabled by default; the default never sends a prompt to a model.',
    '',
    '--probe   Send a minimal request to every discovered model. This may consume',
    '          the signed-in local CLI subscription and egress to its provider.',
    '--enrich  Ask one signed-in local CLI model to classify discovered IDs. This',
    '          may consume the signed-in local CLI subscription and egress to its provider.',
    '',
    'No provider API key is read, required, or recommended by this script.',
  ].join('\n');
}

export function parseCatalogRefreshOptions(argv: readonly string[]): CatalogRefreshOptions {
  let probe = false;
  let enrich = false;
  let help = false;
  for (const argument of argv) {
    if (argument === '--probe') probe = true;
    else if (argument === '--enrich') enrich = true;
    else if (argument === '--help' || argument === '-h') help = true;
    else throw new Error(`Unknown refresh-catalog option: ${JSON.stringify(argument)}`);
  }
  return { probe, enrich, help };
}

function discoverModels(config: CatalogCLIConfig): string[] | null {
  const scriptPath = resolve(scriptDirectory, '..', config.extractScript);
  console.log(`  [discover] Running ${config.extractScript}...`);
  try {
    const output = execFileSync('bash', [scriptPath], {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const parsed: unknown = JSON.parse(output.trim());
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error(`  [discover] ${config.name}: script returned empty or non-array`);
      return null;
    }
    const valid = parsed.filter(
      (id: unknown): id is string => typeof id === 'string' && id.startsWith(config.expectedPrefix),
    );
    if (valid.length === 0) {
      console.error(`  [discover] ${config.name}: no IDs matching prefix "${config.expectedPrefix}"`);
      return null;
    }
    console.log(`  [discover] ${config.name}: found ${valid.length} model IDs`);
    return valid;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  [discover] ${config.name}: extraction failed — ${message}`);
    return null;
  }
}

function loadExisting(): GeneratedFile | null {
  if (!existsSync(generatedPath)) return null;
  try {
    return JSON.parse(readFileSync(generatedPath, 'utf-8')) as GeneratedFile;
  } catch {
    return null;
  }
}

function preserveExistingCatalog(
  config: CatalogCLIConfig,
  existing: GeneratedFile | null,
  catalogs: Record<string, GeneratedCatalog>,
): void {
  if (existing?.catalogs[config.name]) {
    console.log(`  [fallback] keeping entire previous catalog for ${config.name}`);
    catalogs[config.name] = existing.catalogs[config.name];
  } else {
    console.warn(`  [fallback] no previous catalog for ${config.name}, skipping`);
  }
}

function main(): void {
  let options: CatalogRefreshOptions;
  try {
    options = parseCatalogRefreshOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${refreshCatalogUsage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(refreshCatalogUsage());
    return;
  }

  console.log('Refreshing model catalog...\n');
  console.log(options.probe || options.enrich
    ? 'Model prompts are enabled only for the selected opt-in phases.'
    : 'Model prompts are disabled by default. Use --probe and/or --enrich to opt in.');
  const existing = loadExisting();
  const catalogs: Record<string, GeneratedCatalog> = {};
  let anyDiscoverySuccess = false;

  for (const config of CLI_CONFIGS) {
    console.log(`\n--- ${config.name.toUpperCase()} ---`);
    const discovered = discoverModels(config);
    if (!discovered) {
      preserveExistingCatalog(config, existing, catalogs);
      continue;
    }
    const modelPhase = runOptionalModelPhases(config, discovered, options);
    if (modelPhase.modelIds.length === 0) {
      console.warn(`  [probe] all models failed probing for ${config.name}`);
      preserveExistingCatalog(config, existing, catalogs);
      continue;
    }
    anyDiscoverySuccess = true;
    catalogs[config.name] = assignTiers(
      modelPhase.modelIds,
      modelPhase.enrichment,
      existing?.catalogs[config.name] ?? null,
      config.name,
    );
    const total = catalogs[config.name].tiers.reduce((sum, tier) => sum + tier.models.length, 0);
    console.log(`  [result] ${config.name}: ${total} models across ${catalogs[config.name].tiers.length} tiers`);
  }

  if (!anyDiscoverySuccess && !existing) {
    console.error('\nAll CLIs failed discovery and no existing catalog. Aborting.');
    process.exitCode = 1;
    return;
  }
  const missing = CLI_CONFIGS.map(config => config.name)
    .filter(name => !catalogs[name]?.tiers?.length);
  if (missing.length > 0) {
    console.error(`\nRefusing to write incomplete catalog — missing entries for: ${missing.join(', ')}`);
    console.error(existing
      ? 'The existing generated file has been preserved.'
      : 'No catalog file was written (no existing file to preserve).');
    process.exitCode = 1;
    return;
  }
  if (existing && JSON.stringify(getModelSets(existing.catalogs)) === JSON.stringify(getModelSets(catalogs))) {
    console.log('\n⊘ No model additions or removals detected — skipping write.');
    return;
  }

  const output: GeneratedFile = { generatedAt: new Date().toISOString(), catalogs };
  writeFileSync(generatedPath, `${JSON.stringify(output, null, 2)}\n`, 'utf-8');
  console.log(`\n✓ Wrote ${generatedPath}`);
  console.log(`  ${Object.keys(catalogs).length}/${CLI_CONFIGS.length} CLIs in catalog.`);
}

const isDirectExecution = process.argv[1]?.endsWith('refresh-catalog.ts')
  || process.argv[1]?.endsWith('refresh-catalog.js');
if (isDirectExecution) main();
