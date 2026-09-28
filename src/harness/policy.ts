import { stableFingerprint, type FingerprintValue } from './fingerprint.js';
import {
  IMMUTABLE_SAFETY_RULE_IDS,
  type HarnessCheckRequirement,
  type HarnessLimits,
  type HarnessPolicyLayer,
  type HarnessPolicySource,
  type HarnessSeverity,
  type ImmutableSafetyCheck,
  type ResolvedHarnessCheck,
  type ResolvedHarnessPolicyLayer,
  type ResolvedHarnessProfile,
  type StructuredCommand,
  type HarnessProfileInput,
} from './types.js';

const SEVERITY_ORDER: Readonly<Record<HarnessSeverity, number>> = Object.freeze({
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
});

const immutableChecks: ImmutableSafetyCheck[] = [
  {
    ruleId: 'secrets.detected',
    severity: 'critical',
    required: true,
    waivable: false,
    description: 'Literal credentials and tokens may not enter commands, changes, or logs.',
  },
  {
    ruleId: 'files.protected-symlink-alias',
    severity: 'critical',
    required: true,
    waivable: false,
    description: 'Protected agent-instruction aliases and escaping symlinks may not be written.',
  },
  {
    ruleId: 'commands.structured-argv',
    severity: 'critical',
    required: true,
    waivable: false,
    description: 'External checks must use executable plus argv, never interpolated shell text.',
  },
  {
    ruleId: 'mcp.stdout.protocol-only',
    severity: 'critical',
    required: true,
    waivable: false,
    description: 'MCP stdio output must be exclusively JSON-RPC protocol data.',
  },
  {
    ruleId: 'logging.no-content-by-default',
    severity: 'critical',
    required: true,
    waivable: false,
    description: 'MCP prompts, replies, arguments, and command output may not be logged by default.',
  },
  {
    ruleId: 'provider.resume.dangerous-flags',
    severity: 'critical',
    required: true,
    waivable: false,
    description: 'Resumed provider sessions may not use dangerous approval or persistence flags.',
  },
  {
    ruleId: 'provider.resume.pinned',
    severity: 'critical',
    required: true,
    waivable: false,
    description: 'A resumed turn may not change its pinned model, sandbox, or workspace.',
  },
  {
    ruleId: 'harness.no-false-green',
    severity: 'critical',
    required: true,
    waivable: false,
    description: 'A required check that did not pass can never make a gate green.',
  },
];

/** The immutable floor is frozen both at the array and check-object level. */
export const IMMUTABLE_SAFETY_CHECKS: readonly ImmutableSafetyCheck[] = Object.freeze(
  immutableChecks.map((check) => Object.freeze({ ...check })),
);

const PROTECTED_RULE_IDS = new Set<string>(IMMUTABLE_SAFETY_RULE_IDS);

const BUILT_IN_LAYER: ResolvedHarnessPolicyLayer = Object.freeze({
  source: 'built_in',
  id: 'multicli-immutable-floor',
  revision: 'v1',
});

function maxSeverity(left: HarnessSeverity, right: HarnessSeverity): HarnessSeverity {
  return SEVERITY_ORDER[left] >= SEVERITY_ORDER[right] ? left : right;
}

function cloneCommand(command: StructuredCommand): StructuredCommand {
  const env = command.env === undefined
    ? undefined
    : Object.freeze(Object.fromEntries(
      Object.entries(command.env).map(([name, value]) => [name, safeEnvironmentValue(name, value)]),
    ));
  return Object.freeze({
    executable: command.executable,
    // Resolved profile snapshots must never retain a literal credential. A
    // publisher must use a secret reference for an executable command.
    argv: Object.freeze(sanitizeCommandArgv(command.argv)),
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    ...(env === undefined ? {} : { env }),
  });
}

function isFiniteLimit(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function tightenLimit(current: number | undefined, next: number | undefined): number | undefined {
  if (!isFiniteLimit(next)) return current;
  return current === undefined ? next : Math.min(current, next);
}

function mergeLimits(current: HarnessLimits, next: HarnessLimits | undefined): HarnessLimits {
  if (next === undefined) return current;

  return Object.freeze({
    maxDurationMs: tightenLimit(current.maxDurationMs, next.maxDurationMs),
    maxOutputBytes: tightenLimit(current.maxOutputBytes, next.maxOutputBytes),
    maxSubjects: tightenLimit(current.maxSubjects, next.maxSubjects),
  });
}

function newCheck(
  requirement: HarnessCheckRequirement,
  source: HarnessPolicySource,
): ResolvedHarnessCheck {
  const required = requirement.required === true;
  return Object.freeze({
    ruleId: requirement.ruleId,
    required,
    allowSkip: required ? false : requirement.allowSkip === true,
    severity: requirement.severity ?? (required ? 'error' : 'warning'),
    waivable: requirement.waivable !== false,
    source,
  });
}

function mergeCheck(
  current: ResolvedHarnessCheck,
  requirement: HarnessCheckRequirement,
  source: HarnessPolicySource,
): ResolvedHarnessCheck {
  const required = current.required || requirement.required === true;
  return Object.freeze({
    ruleId: current.ruleId,
    required,
    // Once skipping is forbidden, lower layers cannot make it allowed again.
    allowSkip: required ? false : current.allowSkip && requirement.allowSkip !== false,
    // Workspace and workflow packs may raise severity, but never lower it.
    severity: maxSeverity(current.severity, requirement.severity ?? current.severity),
    // An immutable/non-waivable check cannot be made waivable downstream.
    waivable: current.waivable && requirement.waivable !== false,
    source,
  });
}

function addLayerChecks(
  checks: Map<string, ResolvedHarnessCheck>,
  layer: HarnessPolicyLayer,
  source: HarnessPolicySource,
): void {
  for (const requirement of layer.checks ?? []) {
    if (requirement.ruleId.trim().length === 0) continue;
    const current = checks.get(requirement.ruleId);
    checks.set(
      requirement.ruleId,
      current === undefined ? newCheck(requirement, source) : mergeCheck(current, requirement, source),
    );
  }
}

function safeCommandArgument(argument: string): string {
  const appearsSensitive = /(?:\bsk-[a-z0-9_-]{8,}|\b(?:rk|pk)_[a-z0-9_-]{8,}|\bbearer\s+|-----BEGIN [A-Z ]*PRIVATE KEY-----|^(?:--?)(?:api[_-]?key|token|secret|password|authorization|credential|private[_-]?key)=)/i.test(argument);
  return appearsSensitive ? '<redacted>' : argument;
}

function isSensitiveValueFlag(argument: string): boolean {
  return /^(?:--?)(?:api[_-]?key|token|secret|password|authorization|credential|private[_-]?key|access[_-]?key)$/i.test(argument);
}

function sanitizeCommandArgv(argv: readonly string[]): readonly string[] {
  return argv.map((argument, index) => {
    if (isSensitiveValueFlag(argv[index - 1] ?? '')) return '<redacted>';
    return safeCommandArgument(argument);
  });
}

function safeEnvironmentValue(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const sensitiveName = /(?:api[_-]?key|token|secret|password|authorization|credential|private[_-]?key|access[_-]?key)/i.test(name);
  return sensitiveName || safeCommandArgument(value) === '<redacted>' ? '<redacted>' : value;
}

function commandShape(command: StructuredCommand): FingerprintValue {
  return {
    executable: command.executable,
    argv: sanitizeCommandArgv(command.argv),
    cwd: command.cwd,
    // Environment names convey allowlist shape while never hashing values.
    envNames: command.env === undefined ? undefined : Object.keys(command.env).sort(),
  };
}

function profileFingerprintShape(
  id: string,
  revision: string,
  layers: readonly ResolvedHarnessPolicyLayer[],
  checks: readonly ResolvedHarnessCheck[],
  limits: HarnessLimits,
  commands: readonly StructuredCommand[],
): FingerprintValue {
  return {
    id,
    revision,
    layers: layers.map((layer) => ({
      source: layer.source,
      id: layer.id,
      revision: layer.revision,
    })),
    checks: checks.map((check) => ({
      ruleId: check.ruleId,
      required: check.required,
      allowSkip: check.allowSkip,
      severity: check.severity,
      waivable: check.waivable,
      source: check.source,
    })),
    limits: {
      maxDurationMs: limits.maxDurationMs,
      maxOutputBytes: limits.maxOutputBytes,
      maxSubjects: limits.maxSubjects,
    },
    commands: commands.map(commandShape),
  };
}

function addLayerMetadata(
  layers: ResolvedHarnessPolicyLayer[],
  source: HarnessPolicySource,
  layer: HarnessPolicyLayer,
): void {
  layers.push(Object.freeze({ source, id: layer.id, revision: layer.revision }));
}

/**
 * Resolves the policy stack in its fixed order.  The immutable floor is always
 * present. Lower layers can add/tighten rules, but cannot disable floor rules
 * or relax a prior required/non-waivable requirement.
 */
export function resolveHarnessProfile(input: HarnessProfileInput): ResolvedHarnessProfile {
  const layers: ResolvedHarnessPolicyLayer[] = [BUILT_IN_LAYER];
  const checks = new Map<string, ResolvedHarnessCheck>();
  const commands: StructuredCommand[] = [];
  let limits: HarnessLimits = Object.freeze({});

  for (const check of IMMUTABLE_SAFETY_CHECKS) {
    checks.set(check.ruleId, Object.freeze({
      ruleId: check.ruleId,
      required: true,
      allowSkip: false,
      severity: check.severity,
      waivable: false,
      source: 'built_in',
    }));
  }

  const regularLayers: readonly [HarnessPolicySource, HarnessPolicyLayer | undefined][] = [
    ['user_global', input.userGlobal],
    ['workspace', input.workspace],
    ['workflow', input.workflow],
  ];

  for (const [source, layer] of regularLayers) {
    if (layer === undefined) continue;
    addLayerMetadata(layers, source, layer);
    addLayerChecks(checks, layer, source);
    limits = mergeLimits(limits, layer.limits);
    commands.push(...(layer.commands ?? []).filter(isStructuredCommand).map(cloneCommand));
  }

  // A run override may only tighten numerical limits, and only if the published
  // workflow explicitly opted in. It never changes commands or check policy.
  if (input.workflow?.allowRunOverride === true && input.runOverride !== undefined) {
    addLayerMetadata(layers, 'run_override', input.runOverride);
    limits = mergeLimits(limits, input.runOverride.limits);
  }

  const resolvedChecks = Object.freeze(
    [...checks.values()].sort((left, right) => left.ruleId.localeCompare(right.ruleId)),
  );
  const resolvedLayers = Object.freeze([...layers]);
  const resolvedCommands = Object.freeze([...commands]);
  const resolvedLimits = Object.freeze({ ...limits });
  const hash = stableFingerprint(
    'harness.profile',
    profileFingerprintShape(
      input.id,
      input.revision,
      resolvedLayers,
      resolvedChecks,
      resolvedLimits,
      resolvedCommands,
    ),
  );

  return Object.freeze({
    id: input.id,
    revision: input.revision,
    hash,
    layers: resolvedLayers,
    checks: resolvedChecks,
    limits: resolvedLimits,
    commands: resolvedCommands,
  });
}

/** Runtime guard for config parsers or JavaScript callers. */
export function isStructuredCommand(value: unknown): value is StructuredCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.executable !== 'string' || candidate.executable.trim().length === 0) {
    return false;
  }
  if (!Array.isArray(candidate.argv) || !candidate.argv.every((argument) => typeof argument === 'string')) {
    return false;
  }
  if (candidate.cwd !== undefined && typeof candidate.cwd !== 'string') return false;
  if (candidate.env !== undefined) {
    if (typeof candidate.env !== 'object' || candidate.env === null || Array.isArray(candidate.env)) {
      return false;
    }
    if (!Object.values(candidate.env).every((item) => item === undefined || typeof item === 'string')) {
      return false;
    }
  }
  return true;
}

export function isImmutableSafetyRule(ruleId: string): boolean {
  return PROTECTED_RULE_IDS.has(ruleId);
}
