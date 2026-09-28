export type ModelTier = 'fast' | 'balanced' | 'powerful';

export interface EnrichmentEntry {
  id: string;
  tier: ModelTier;
  displayName: string;
  description: string;
}

export interface GeneratedTier {
  tier: ModelTier;
  models: string[];
}

export interface GeneratedCatalog {
  cli: string;
  tiers: GeneratedTier[];
}

export interface GeneratedFile {
  generatedAt: string;
  catalogs: Record<string, GeneratedCatalog>;
}

export interface StructuredCommand {
  readonly executable: string;
  readonly argv: readonly string[];
}

export interface CatalogCLIConfig {
  name: string;
  expectedPrefix: string;
  extractScript: string;
  fastModelPattern: RegExp;
  /** Dynamic values remain separate argv entries; never interpolate a shell command. */
  buildModelCommand: (model: string, prompt: string) => StructuredCommand;
}

export interface CatalogRefreshOptions {
  readonly probe: boolean;
  readonly enrich: boolean;
  readonly help: boolean;
}

export interface OptionalModelPhaseResult {
  readonly modelIds: string[];
  readonly enrichment: EnrichmentEntry[] | null;
}
