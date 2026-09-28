/**
 * Provider-neutral contracts for the deterministic harness.  These values are
 * deliberately data-only: adapters may construct them, but the core never
 * executes a shell command or retains provider payloads.
 */

export const HARNESS_TRIGGERS = [
  'pre_tool',
  'post_edit',
  'node_exit',
  'pre_commit',
  'pre_push',
  'pre_publish',
  'ci',
] as const;

export type HarnessTrigger = (typeof HARNESS_TRIGGERS)[number];

export const HARNESS_ACTOR_KINDS = [
  'user',
  'claude',
  'codex',
  'provider',
  'ci',
] as const;

export type HarnessActorKind = (typeof HARNESS_ACTOR_KINDS)[number];

export interface HarnessActor {
  readonly kind: HarnessActorKind;
  /** An opaque provider or user identifier; it must not contain prompt text. */
  readonly id?: string;
  /** Lets future providers retain their identity without changing the schema. */
  readonly provider?: string;
}

export type HarnessSeverity = 'info' | 'warning' | 'error' | 'critical';

export type HarnessOutcome = 'pass' | 'warn' | 'block' | 'error';

/**
 * A changed file or patch target. `content` and `addedText` are transient input
 * for deterministic checks; neither field is copied into a HarnessResult.
 */
export interface ChangedSubject {
  readonly path: string;
  readonly content?: string;
  readonly addedText?: string;
  readonly line?: number;
  readonly beforeHash?: string;
  readonly afterHash?: string;
  /** Supplied by an adapter after an lstat/realpath check, never inferred here. */
  readonly isSymlink?: boolean;
  /** Canonical target supplied by the adapter when `isSymlink` is true. */
  readonly resolvedPath?: string;
}

/**
 * Commands are always an executable plus argv.  There is intentionally no
 * shell-string field: this package never interpolates or invokes a shell.
 */
export interface StructuredCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  /** Sensitive values are input-only and are never returned or fingerprinted verbatim. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface HarnessMcpLogging {
  readonly prompts?: boolean;
  readonly replies?: boolean;
  readonly toolArguments?: boolean;
  readonly commandOutput?: boolean;
}

export interface HarnessMcpConfiguration {
  readonly transport: 'stdio' | 'http';
  /** stdio must explicitly be declared protocol-only. */
  readonly stdoutMode?: 'protocol-only' | 'mixed' | 'operational';
  readonly forwardOperationalOutputToStdout?: boolean;
  readonly logging?: HarnessMcpLogging;
}

export interface ResumePin {
  readonly model?: string;
  readonly sandbox?: string;
  readonly workspace?: string;
}

export interface HarnessResume {
  /** Explicitly marks this as a resume even when argv does not expose it. */
  readonly enabled?: boolean;
  /** Values pinned when the native provider thread was created. */
  readonly pinned?: ResumePin;
  /** Values requested for the resumed turn. */
  readonly requested?: ResumePin;
}

export interface HarnessToolMetadata {
  readonly name: string;
  readonly inputHash: string;
  readonly responseHash?: string;
}

export interface HarnessFinding {
  readonly ruleId: string;
  readonly severity: HarnessSeverity;
  readonly path?: string;
  readonly line?: number;
  readonly message: string;
  readonly repair: string;
  readonly fingerprint: string;
  /** Required findings block until repaired; advisory findings may only warn. */
  readonly required: boolean;
  /** Immutable built-ins are always false, regardless of profile configuration. */
  readonly waivable: boolean;
  /** An opaque, redacted evidence reference; never inline prompt or secret text. */
  readonly evidenceRef?: string;
}

export interface HarnessWaiver {
  readonly fingerprint: string;
  readonly reason: string;
  readonly actor: string;
  readonly approvedBy: string;
  /** Waivers must expire; an invalid or expired timestamp has no effect. */
  readonly expiresAt: string;
}

export type HarnessCheckStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'unavailable'
  | 'timed_out';

/**
 * Result reported by an adapter-owned external deterministic check.  Its
 * evidence must already be redacted by the adapter before entering this core.
 */
export interface HarnessCheckExecution {
  readonly ruleId: string;
  readonly status: HarnessCheckStatus;
  readonly reason?: string;
  readonly findings?: readonly HarnessFinding[];
}

export interface HarnessCheckRequirement {
  readonly ruleId: string;
  readonly required?: boolean;
  readonly allowSkip?: boolean;
  readonly severity?: HarnessSeverity;
  readonly waivable?: boolean;
}

export interface HarnessLimits {
  readonly maxDurationMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxSubjects?: number;
}

/** A declarative layer. Commands cannot be represented as shell strings. */
export interface HarnessPolicyLayer {
  readonly id: string;
  readonly revision: string;
  readonly checks?: readonly HarnessCheckRequirement[];
  readonly limits?: HarnessLimits;
  readonly commands?: readonly StructuredCommand[];
  /** Only a published workflow may permit a run-level limit reduction. */
  readonly allowRunOverride?: boolean;
}

export type HarnessPolicySource =
  | 'built_in'
  | 'user_global'
  | 'workspace'
  | 'workflow'
  | 'run_override';

export interface ResolvedHarnessCheck {
  readonly ruleId: string;
  readonly required: boolean;
  readonly allowSkip: boolean;
  readonly severity: HarnessSeverity;
  readonly waivable: boolean;
  readonly source: HarnessPolicySource;
}

export interface ResolvedHarnessPolicyLayer {
  readonly source: HarnessPolicySource;
  readonly id: string;
  readonly revision: string;
}

export interface HarnessProfileInput {
  readonly id: string;
  readonly revision: string;
  readonly userGlobal?: HarnessPolicyLayer;
  readonly workspace?: HarnessPolicyLayer;
  readonly workflow?: HarnessPolicyLayer;
  readonly runOverride?: HarnessPolicyLayer;
}

export interface ResolvedHarnessProfile {
  readonly id: string;
  readonly revision: string;
  readonly hash: string;
  readonly layers: readonly ResolvedHarnessPolicyLayer[];
  readonly checks: readonly ResolvedHarnessCheck[];
  readonly limits: HarnessLimits;
  readonly commands: readonly StructuredCommand[];
}

export interface HarnessRequest {
  readonly trigger: HarnessTrigger;
  readonly actor: HarnessActor;
  readonly workspace: string;
  readonly runId?: string;
  readonly nodeAttemptId?: string;
  readonly tool?: HarnessToolMetadata;
  readonly changes: readonly ChangedSubject[];
  readonly profileRevision: string;
  /** Optional caller-provided opaque ID. If absent, a stable safe ID is derived. */
  readonly invocationId?: string;
  readonly command?: StructuredCommand;
  readonly mcp?: HarnessMcpConfiguration;
  readonly resume?: HarnessResume;
  /** Raw hook input is consumed transiently, normalized, and never returned. */
  readonly hookPayload?: unknown;
  readonly checkExecutions?: readonly HarnessCheckExecution[];
  readonly waivers?: readonly HarnessWaiver[];
}

export interface HarnessSkippedCheck {
  readonly ruleId: string;
  readonly reason: string;
  readonly allowed: boolean;
}

export interface HarnessResult {
  readonly invocationId: string;
  readonly outcome: HarnessOutcome;
  /** Includes waived findings so UI/audit consumers can show the full picture. */
  readonly findings: readonly HarnessFinding[];
  readonly unwaivedFindings: readonly HarnessFinding[];
  readonly waivedFindings: readonly HarnessFinding[];
  readonly requiredChecks: number;
  readonly executedChecks: number;
  readonly skippedChecks: readonly HarnessSkippedCheck[];
  readonly profile: ResolvedHarnessProfile;
}

export type NormalizedHookOperation = 'edit' | 'write' | 'apply_patch';

export interface NormalizedHookPayload {
  readonly provider: 'claude' | 'codex';
  readonly operation: NormalizedHookOperation;
  readonly toolName: string;
  readonly changes: readonly ChangedSubject[];
}

export const IMMUTABLE_SAFETY_RULE_IDS = [
  'secrets.detected',
  'files.protected-symlink-alias',
  'commands.structured-argv',
  'mcp.stdout.protocol-only',
  'logging.no-content-by-default',
  'provider.resume.dangerous-flags',
  'provider.resume.pinned',
  'harness.no-false-green',
] as const;

export type ImmutableSafetyRuleId = (typeof IMMUTABLE_SAFETY_RULE_IDS)[number];

export interface ImmutableSafetyCheck {
  readonly ruleId: ImmutableSafetyRuleId;
  readonly severity: HarnessSeverity;
  readonly required: true;
  readonly waivable: false;
  readonly description: string;
}
