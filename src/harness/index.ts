/**
 * Public, dependency-free entry point for the deterministic provider-neutral
 * harness. Adapters may import from this module without coupling to current
 * CLI executors or the future control plane.
 */

export {
  applyHarnessWaivers,
  evaluateHarness,
  runHarness,
  type AppliedHarnessWaivers,
  type HarnessEvaluationOptions,
} from './engine.js';
export {
  changedSubjectsForRequest,
  runImmutableSafetyChecks,
  sortHarnessFindings,
} from './checks.js';
export {
  changedSubjectsFromPatch,
  normalizeClaudeHookPayload,
  normalizeCodexHookPayload,
  normalizeHookPayload,
} from './hooks.js';
export {
  IMMUTABLE_SAFETY_CHECKS,
  isImmutableSafetyRule,
  isStructuredCommand,
  resolveHarnessProfile,
} from './policy.js';
export { canonicalJson, stableFingerprint, type FingerprintValue } from './fingerprint.js';
export type {
  ChangedSubject,
  HarnessActor,
  HarnessActorKind,
  HarnessCheckExecution,
  HarnessCheckRequirement,
  HarnessCheckStatus,
  HarnessFinding,
  HarnessLimits,
  HarnessMcpConfiguration,
  HarnessMcpLogging,
  HarnessOutcome,
  HarnessPolicyLayer,
  HarnessPolicySource,
  HarnessProfileInput,
  HarnessRequest,
  HarnessResult,
  HarnessResume,
  HarnessSeverity,
  HarnessSkippedCheck,
  HarnessToolMetadata,
  HarnessTrigger,
  HarnessWaiver,
  ImmutableSafetyCheck,
  ImmutableSafetyRuleId,
  NormalizedHookOperation,
  NormalizedHookPayload,
  ResolvedHarnessCheck,
  ResolvedHarnessPolicyLayer,
  ResolvedHarnessProfile,
  ResumePin,
  StructuredCommand,
} from './types.js';

export {
  MULTICLI_REPOSITORY_CHECKS,
  runRepositoryHarness,
  runStructuredRepositoryCheck,
  type RepositoryCheckRunner,
  type RepositoryCheckSummary,
  type RepositoryHarnessReport,
} from './repository.js';

export {
  countPhysicalLines,
  inspectRepositorySourceLines,
  SOURCE_LINE_BLOCKING_LIMIT,
  SOURCE_LINE_BLOCKING_RULE_ID,
  SOURCE_LINE_WARNING_LIMIT,
  SOURCE_LINE_WARNING_RULE_ID,
  type RepositorySourceLineInspector,
  type RepositorySourceLineReport,
} from './sourceLines.js';

export { handleHarnessCommand } from './cli.js';
export {
  HARNESS_ACTOR_KINDS,
  HARNESS_TRIGGERS,
  IMMUTABLE_SAFETY_RULE_IDS,
} from './types.js';
