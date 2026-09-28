import { getCatalog } from '../modelCatalog.js';
import { validateWorkflowRevision, type WorkflowValidationResult } from './graph.js';
import {
  CLAUDE_WORKFLOW_MODELS,
  CODEX_WORKFLOW_MODELS,
} from './providerPolicy.js';

const CATALOG_MODEL_IDS = Object.freeze({
  codex: new Set(getCatalog('codex').tiers.flatMap(tier => tier.models)),
  claude: new Set(getCatalog('claude').tiers.flatMap(tier => tier.models)),
});

const WORKFLOW_MODEL_IDS = Object.freeze({
  codex: new Set<string>(CODEX_WORKFLOW_MODELS),
  claude: new Set<string>(CLAUDE_WORKFLOW_MODELS),
});

export function cataloguedWorkflowModels(provider: 'codex' | 'claude'): readonly string[] {
  const preferred = provider === 'codex' ? CODEX_WORKFLOW_MODELS : CLAUDE_WORKFLOW_MODELS;
  return preferred.filter(model => CATALOG_MODEL_IDS[provider].has(model));
}

/** Add local adapter/catalog checks to the provider-neutral graph validator. */
export function validateLocalWorkflowRevision(value: unknown): WorkflowValidationResult {
  const base = validateWorkflowRevision(value);
  if (!value || typeof value !== 'object' || !Array.isArray((value as { profiles?: unknown }).profiles)) {
    return base;
  }
  const issues = [...base.issues];
  for (const entry of (value as { profiles: unknown[] }).profiles) {
    if (!entry || typeof entry !== 'object') continue;
    const profile = entry as { id?: unknown; provider?: unknown; model?: unknown };
    if ((profile.provider === 'codex' || profile.provider === 'claude')
      && typeof profile.model === 'string'
      && (!WORKFLOW_MODEL_IDS[profile.provider].has(profile.model)
        || !CATALOG_MODEL_IDS[profile.provider].has(profile.model))) {
      issues.push({
        code: 'invalid-profile',
        message: `Profile ${JSON.stringify(profile.id)} model ${JSON.stringify(profile.model)} is not a supported local ${profile.provider} workflow model.`,
      });
    }
  }
  return { valid: issues.length === 0, issues };
}
