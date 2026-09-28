import { stableFingerprint, type FingerprintValue } from './fingerprint.js';
import { normalizeHookPayload } from './hooks.js';
import { IMMUTABLE_SAFETY_CHECKS, isStructuredCommand } from './policy.js';
import type {
  ChangedSubject,
  HarnessFinding,
  HarnessRequest,
  ImmutableSafetyRuleId,
} from './types.js';

const SENSITIVE_NAME_PATTERN = /(?:api[_-]?key|token|secret|password|passwd|authorization|credential|private[_-]?key|access[_-]?key)/i;
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[a-z0-9_-]{8,}\b/i,
  /\b(?:rk|pk)_[a-z0-9_-]{8,}\b/i,
  /\bxox(?:b|p|a|r|s)-[a-z0-9-]{8,}\b/i,
  /\bgh[pousr]_[a-z0-9]{8,}\b/i,
  /\bgithub_pat_[a-z0-9_]{8,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const PROTECTED_SYMLINK_ALIASES = new Set(['claude.md', 'codex.md', 'gemini.md']);
const PROTECTED_PATH_SEGMENTS = new Set(['.git', '.claude', '.codex', '.multicli', '.ssh']);

interface SecretLocation {
  readonly locator: string;
  readonly path?: string;
  readonly line?: number;
}

function immutableSeverity(ruleId: ImmutableSafetyRuleId): HarnessFinding['severity'] {
  const check = IMMUTABLE_SAFETY_CHECKS.find((candidate) => candidate.ruleId === ruleId);
  // The IDs and definitions live in the same immutable module. This fallback is
  // only defensive for future edits and preserves a fail-closed severity.
  return check?.severity ?? 'critical';
}

function immutableFinding(
  ruleId: ImmutableSafetyRuleId,
  message: string,
  repair: string,
  context: FingerprintValue,
  location: Pick<HarnessFinding, 'path' | 'line'> = {},
): HarnessFinding {
  return Object.freeze({
    ruleId,
    severity: immutableSeverity(ruleId),
    ...location,
    message,
    repair,
    fingerprint: stableFingerprint(ruleId, context),
    required: true,
    waivable: false,
  });
}

function isSecretReference(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0
    || /^\[?redacted\]?$/i.test(trimmed)
    || /^\$\{?[A-Z][A-Z0-9_]*\}?$/.test(trimmed)
    || /^(?:env|secret|vault):/i.test(trimmed);
}

function containsSecret(value: string): boolean {
  if (isSecretReference(value)) return false;
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function requestProvider(request: HarnessRequest): 'claude' | 'codex' | undefined {
  if (request.actor.kind === 'claude' || request.actor.kind === 'codex') return request.actor.kind;
  const provider = request.actor.provider?.toLowerCase();
  if (provider === 'claude' || provider === 'codex') return provider;
  const executable = request.command?.executable.toLowerCase();
  if (executable?.includes('claude')) return 'claude';
  if (executable?.includes('codex')) return 'codex';
  return undefined;
}

/** Combines direct adapter subjects with a transient normalized hook payload. */
export function changedSubjectsForRequest(request: HarnessRequest): readonly ChangedSubject[] {
  const subjects = [...request.changes];
  const provider = requestProvider(request);
  if (provider !== undefined && request.hookPayload !== undefined) {
    const normalized = normalizeHookPayload(provider, request.hookPayload);
    if (normalized !== undefined) subjects.push(...normalized.changes);
  }
  return Object.freeze(subjects);
}

function recordSecret(
  locations: Map<string, SecretLocation>,
  location: SecretLocation,
): void {
  const key = `${location.path ?? ''}\u0000${location.line ?? ''}\u0000${location.locator}`;
  locations.set(key, location);
}

function secretLocations(request: HarnessRequest, subjects: readonly ChangedSubject[]): readonly SecretLocation[] {
  const locations = new Map<string, SecretLocation>();
  const command = request.command;

  if (command !== undefined) {
    for (let index = 0; index < command.argv.length; index += 1) {
      const argument = command.argv[index];
      if (containsSecret(argument)) {
        recordSecret(locations, { locator: `argv[${index}]` });
        continue;
      }

      const flagAssignment = /^(?:--?)([^=]+)=(.*)$/.exec(argument);
      if (flagAssignment !== null && SENSITIVE_NAME_PATTERN.test(flagAssignment[1])
        && !isSecretReference(flagAssignment[2])) {
        recordSecret(locations, { locator: `argv[${index}]` });
        continue;
      }

      if (SENSITIVE_NAME_PATTERN.test(argument) && index + 1 < command.argv.length) {
        const next = command.argv[index + 1];
        if (!next.startsWith('-') && !isSecretReference(next)) {
          recordSecret(locations, { locator: `argv[${index + 1}]` });
        }
      }
    }

    for (const [name, value] of Object.entries(command.env ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      if (value === undefined || isSecretReference(value)) continue;
      if (SENSITIVE_NAME_PATTERN.test(name) || containsSecret(value)) {
        recordSecret(locations, { locator: `env:${name}` });
      }
    }
  }

  for (const subject of subjects) {
    const values: readonly ['content' | 'addedText', string | undefined][] = [
      ['content', subject.content],
      ['addedText', subject.addedText],
    ];
    for (const [field, value] of values) {
      if (value !== undefined && containsSecret(value)) {
        recordSecret(locations, {
          locator: `change:${field}`,
          path: canonicalPath(subject.path),
          ...(subject.line === undefined ? {} : { line: subject.line }),
        });
      }
    }
  }

  return [...locations.values()].sort((left, right) => {
    const leftKey = `${left.path ?? ''}\u0000${left.line ?? ''}\u0000${left.locator}`;
    const rightKey = `${right.path ?? ''}\u0000${right.line ?? ''}\u0000${right.locator}`;
    return leftKey.localeCompare(rightKey);
  });
}

function canonicalPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
}

function pathSegments(path: string): readonly string[] {
  return canonicalPath(path).split('/').filter(Boolean);
}

function hasProtectedSegment(path: string): boolean {
  return pathSegments(path).some((segment) => PROTECTED_PATH_SEGMENTS.has(segment.toLowerCase()));
}

function hasTraversal(path: string): boolean {
  return pathSegments(path).includes('..');
}

function isProtectedAlias(path: string): boolean {
  const segments = pathSegments(path);
  const basename = segments[segments.length - 1]?.toLowerCase();
  return basename !== undefined && PROTECTED_SYMLINK_ALIASES.has(basename);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:\//.test(path);
}

function escapesWorkspace(path: string, workspace: string): boolean {
  const canonicalCandidate = canonicalPath(path).toLowerCase();
  const canonicalWorkspace = canonicalPath(workspace).replace(/\/$/, '').toLowerCase();
  if (!isAbsolutePath(canonicalCandidate) || !isAbsolutePath(canonicalWorkspace)) return false;
  return canonicalCandidate !== canonicalWorkspace && !canonicalCandidate.startsWith(`${canonicalWorkspace}/`);
}

function protectedPathFindings(
  request: HarnessRequest,
  subjects: readonly ChangedSubject[],
): readonly HarnessFinding[] {
  const findings: HarnessFinding[] = [];
  const sortedSubjects = [...subjects].sort((left, right) => canonicalPath(left.path).localeCompare(canonicalPath(right.path)));

  for (const subject of sortedSubjects) {
    const path = canonicalPath(subject.path);
    let reason: string | undefined;

    if (isProtectedAlias(path)) {
      reason = 'agent-instruction-alias';
    } else if (hasTraversal(path)) {
      reason = 'path-traversal';
    } else if (hasProtectedSegment(path)) {
      reason = 'protected-path';
    } else if (subject.isSymlink === true) {
      if (subject.resolvedPath === undefined) {
        reason = 'unresolved-symlink';
      } else if (hasProtectedSegment(subject.resolvedPath) || escapesWorkspace(subject.resolvedPath, request.workspace)) {
        reason = 'symlink-escape';
      }
    }

    if (reason !== undefined) {
      findings.push(immutableFinding(
        'files.protected-symlink-alias',
        'The requested write targets a protected path, agent alias, or escaping symlink.',
        'Write the canonical workspace file only; do not edit instruction aliases or symlinked protected targets.',
        { path, reason },
        { path },
      ));
    }
  }

  return findings;
}

function commandFinding(request: HarnessRequest): HarnessFinding | undefined {
  if (request.command === undefined || isStructuredCommand(request.command)) return undefined;
  return immutableFinding(
    'commands.structured-argv',
    'An external check command was not represented as an executable and argv array.',
    'Use a validated executable plus literal argv values; never construct a shell command string.',
    { command: 'invalid-structured-argv' },
  );
}

function mcpFindings(request: HarnessRequest): readonly HarnessFinding[] {
  const mcp = request.mcp;
  if (mcp === undefined) return [];

  const findings: HarnessFinding[] = [];
  if (mcp.transport === 'stdio'
    && (mcp.stdoutMode !== 'protocol-only' || mcp.forwardOperationalOutputToStdout === true)) {
    findings.push(immutableFinding(
      'mcp.stdout.protocol-only',
      'MCP stdio is not explicitly restricted to protocol-only stdout.',
      'Send operational logs and progress to stderr, and set stdoutMode to protocol-only.',
      {
        transport: mcp.transport,
        stdoutMode: mcp.stdoutMode ?? 'unset',
        forwardsOperationalOutput: mcp.forwardOperationalOutputToStdout === true,
      },
    ));
  }

  const enabledLogSurfaces = Object.entries(mcp.logging ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([surface]) => surface)
    .sort();
  if (enabledLogSurfaces.length > 0) {
    findings.push(immutableFinding(
      'logging.no-content-by-default',
      'MCP content logging is enabled for a prompt, reply, argument, or command-output surface.',
      'Disable content logging and persist only redacted metadata or opaque evidence references.',
      { transport: mcp.transport, surfaces: enabledLogSurfaces },
    ));
  }

  return findings;
}

function isResume(request: HarnessRequest): boolean {
  if (request.resume?.enabled === true) return true;
  const argv = request.command?.argv ?? [];
  return argv.some((argument) => argument === 'resume' || argument === '--resume' || argument.startsWith('--resume='));
}

function dangerousResumeFlags(
  provider: 'claude' | 'codex' | undefined,
  argv: readonly string[],
): readonly string[] {
  const flags = new Set<string>();
  const allowCodex = provider === undefined || provider === 'codex';
  const allowClaude = provider === undefined || provider === 'claude';

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const lower = argument.toLowerCase();
    if (allowCodex && [
      '--full-auto',
      '--ephemeral',
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
    ].includes(lower)) {
      flags.add(lower);
    }
    if (allowClaude && [
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
    ].includes(lower)) {
      flags.add(lower);
    }
    if (allowClaude && (lower === '--permission-mode=bypasspermissions'
      || (lower === '--permission-mode' && argv[index + 1]?.toLowerCase() === 'bypasspermissions'))) {
      flags.add('--permission-mode=bypassPermissions');
    }
  }

  return [...flags].sort();
}

function resumeFindings(request: HarnessRequest): readonly HarnessFinding[] {
  if (!isResume(request)) return [];

  const provider = requestProvider(request);
  const findings: HarnessFinding[] = [];
  const flags = dangerousResumeFlags(provider, request.command?.argv ?? []);
  if (flags.length > 0) {
    findings.push(immutableFinding(
      'provider.resume.dangerous-flags',
      'A resumed provider turn contains a dangerous approval, sandbox, or persistence flag.',
      'Remove dangerous resume flags and rely on the original pinned provider session settings.',
      { provider: provider ?? 'unknown', flags },
    ));
  }

  const pinned = request.resume?.pinned;
  if (pinned === undefined) {
    findings.push(immutableFinding(
      'provider.resume.pinned',
      'A resumed provider turn has no pinned model, sandbox, and workspace snapshot to verify.',
      'Load the original session pin before resume and pass it to the harness.',
      { provider: provider ?? 'unknown', reason: 'missing-pin' },
    ));
    return findings;
  }

  const requested = request.resume?.requested;
  const changedFields = (['model', 'sandbox', 'workspace'] as const)
    .filter((field) => requested?.[field] !== undefined && requested[field] !== pinned[field]);
  if (changedFields.length > 0) {
    findings.push(immutableFinding(
      'provider.resume.pinned',
      'A resumed provider turn attempts to change a pinned model, sandbox, or workspace.',
      'Resume with the exact original model, sandbox, and workspace; start a new approved session for changes.',
      { provider: provider ?? 'unknown', fields: changedFields },
    ));
  }

  return findings;
}

/** Sorts findings without using raw content as a sort key. */
export function sortHarnessFindings(findings: readonly HarnessFinding[]): readonly HarnessFinding[] {
  return Object.freeze([...findings].sort((left, right) => {
    const fingerprintOrder = left.fingerprint.localeCompare(right.fingerprint);
    return fingerprintOrder === 0 ? left.ruleId.localeCompare(right.ruleId) : fingerprintOrder;
  }));
}

/** Runs only the always-on, dependency-free safety floor. */
export function runImmutableSafetyChecks(request: HarnessRequest): readonly HarnessFinding[] {
  const subjects = changedSubjectsForRequest(request);
  const findings: HarnessFinding[] = [];

  for (const location of secretLocations(request, subjects)) {
    findings.push(immutableFinding(
      'secrets.detected',
      'A likely credential or token was supplied to a command, environment, or changed content.',
      'Replace the literal with a secret reference and keep it out of source, argv, logs, and evidence.',
      {
        locator: location.locator,
        path: location.path,
        line: location.line,
      },
      {
        ...(location.path === undefined ? {} : { path: location.path }),
        ...(location.line === undefined ? {} : { line: location.line }),
      },
    ));
  }

  const invalidCommand = commandFinding(request);
  if (invalidCommand !== undefined) findings.push(invalidCommand);
  findings.push(...protectedPathFindings(request, subjects));
  findings.push(...mcpFindings(request));
  findings.push(...resumeFindings(request));

  return sortHarnessFindings(findings);
}
