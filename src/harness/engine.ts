import { stableFingerprint, type FingerprintValue } from './fingerprint.js';
import { runImmutableSafetyChecks, sortHarnessFindings } from './checks.js';
import {
  IMMUTABLE_SAFETY_CHECKS,
  isImmutableSafetyRule,
  resolveHarnessProfile,
} from './policy.js';
import type {
  HarnessCheckExecution,
  HarnessCheckStatus,
  HarnessFinding,
  HarnessOutcome,
  HarnessRequest,
  HarnessResult,
  HarnessSkippedCheck,
  HarnessWaiver,
  ResolvedHarnessCheck,
  ResolvedHarnessProfile,
} from './types.js';

export interface HarnessEvaluationOptions {
  /** Injecting time keeps waiver resolution reproducible in tests and replays. */
  readonly now?: Date;
}

export interface AppliedHarnessWaivers {
  readonly waived: readonly HarnessFinding[];
  readonly unwaived: readonly HarnessFinding[];
}

const STATUS_RANK: Readonly<Record<HarnessCheckStatus, number>> = Object.freeze({
  passed: 0,
  skipped: 1,
  unavailable: 2,
  timed_out: 3,
  failed: 4,
});

const SEVERITY_RANK: Readonly<Record<HarnessFinding['severity'], number>> = Object.freeze({
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
});

const BUILT_IN_RULE_IDS = new Set<string>(IMMUTABLE_SAFETY_CHECKS.map((check) => check.ruleId));

function isActiveWaiver(waiver: HarnessWaiver, now: Date): boolean {
  if (waiver.fingerprint.trim().length === 0
    || waiver.reason.trim().length === 0
    || waiver.actor.trim().length === 0
    || waiver.approvedBy.trim().length === 0) {
    return false;
  }
  const expiresAt = Date.parse(waiver.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

/**
 * Waivers are exact-fingerprint, attributed, expiring records. The immutable
 * floor is not waivable even if a caller supplies a matching record.
 */
export function applyHarnessWaivers(
  findings: readonly HarnessFinding[],
  waivers: readonly HarnessWaiver[] = [],
  options: HarnessEvaluationOptions = {},
): AppliedHarnessWaivers {
  const now = options.now ?? new Date();
  const activeFingerprints = new Set(
    waivers.filter((waiver) => isActiveWaiver(waiver, now)).map((waiver) => waiver.fingerprint),
  );
  const waived: HarnessFinding[] = [];
  const unwaived: HarnessFinding[] = [];

  for (const finding of findings) {
    if (finding.waivable && activeFingerprints.has(finding.fingerprint)) {
      waived.push(finding);
    } else {
      unwaived.push(finding);
    }
  }

  return Object.freeze({
    waived: sortHarnessFindings(waived),
    unwaived: sortHarnessFindings(unwaived),
  });
}

function statusKey(execution: HarnessCheckExecution): string {
  const findingFingerprints = (execution.findings ?? []).map((finding) => finding.fingerprint).sort();
  return `${execution.status}\u0000${findingFingerprints.join('\u0000')}`;
}

/** Collapses duplicate adapter reports conservatively and independently of input order. */
function executionByRule(
  executions: readonly HarnessCheckExecution[],
): ReadonlyMap<string, HarnessCheckExecution> {
  const result = new Map<string, HarnessCheckExecution>();
  for (const execution of executions) {
    const current = result.get(execution.ruleId);
    if (current === undefined
      || STATUS_RANK[execution.status] > STATUS_RANK[current.status]
      || (STATUS_RANK[execution.status] === STATUS_RANK[current.status]
        && statusKey(execution).localeCompare(statusKey(current)) < 0)) {
      result.set(execution.ruleId, execution);
    }
  }
  return result;
}

function highestSeverity(
  left: HarnessFinding['severity'],
  right: HarnessFinding['severity'],
): HarnessFinding['severity'] {
  return SEVERITY_RANK[left] >= SEVERITY_RANK[right] ? left : right;
}

function normalizedExternalFinding(
  finding: HarnessFinding,
  requirement: ResolvedHarnessCheck,
): HarnessFinding {
  const immutable = isImmutableSafetyRule(finding.ruleId);
  return Object.freeze({
    ...finding,
    // A profile's requirement takes precedence over a possibly optimistic adapter.
    required: immutable || requirement.required || finding.required,
    waivable: immutable ? false : requirement.waivable && finding.waivable,
    severity: immutable ? 'critical' : highestSeverity(finding.severity, requirement.severity),
  });
}

function noFalseGreenFinding(
  requirement: ResolvedHarnessCheck,
  status: HarnessCheckStatus | 'missing',
): HarnessFinding {
  const context: FingerprintValue = {
    requiredRuleId: requirement.ruleId,
    status,
  };
  return Object.freeze({
    ruleId: 'harness.no-false-green',
    severity: 'critical',
    message: 'A required deterministic check did not complete successfully.',
    repair: 'Restore the checker and rerun it successfully; a skip, timeout, unavailable dependency, or failure cannot pass this gate.',
    fingerprint: stableFingerprint('harness.no-false-green', context),
    required: true,
    waivable: false,
  });
}

function optionalStatusFinding(
  requirement: ResolvedHarnessCheck,
  status: HarnessCheckStatus,
): HarnessFinding {
  return Object.freeze({
    ruleId: requirement.ruleId,
    severity: requirement.severity,
    message: 'An advisory deterministic check did not complete successfully.',
    repair: 'Restore or rerun the advisory checker before relying on its result.',
    fingerprint: stableFingerprint('harness.optional-check-status', {
      ruleId: requirement.ruleId,
      status,
    }),
    required: false,
    waivable: requirement.waivable,
  });
}

function skippedReason(status: HarnessCheckStatus | 'missing'): string {
  switch (status) {
    case 'missing':
      return 'No execution record was supplied.';
    case 'skipped':
      return 'The check was explicitly skipped.';
    case 'unavailable':
      return 'The check dependency was unavailable.';
    case 'timed_out':
      return 'The check timed out.';
    case 'failed':
      return 'The check failed after execution.';
    case 'passed':
      return 'The check passed.';
  }
}

function deduplicateFindings(findings: readonly HarnessFinding[]): readonly HarnessFinding[] {
  const byFingerprint = new Map<string, HarnessFinding>();
  for (const finding of findings) {
    const current = byFingerprint.get(finding.fingerprint);
    if (current === undefined) {
      byFingerprint.set(finding.fingerprint, finding);
      continue;
    }

    // Deduplication is conservative: a duplicate cannot lower severity,
    // requiredness, or waiver protection. The canonical textual variant keeps
    // output deterministic if a third-party adapter duplicated a fingerprint.
    const currentText = `${current.ruleId}\u0000${current.message}\u0000${current.repair}`;
    const nextText = `${finding.ruleId}\u0000${finding.message}\u0000${finding.repair}`;
    const primary = nextText.localeCompare(currentText) < 0 ? finding : current;
    byFingerprint.set(finding.fingerprint, Object.freeze({
      ...primary,
      severity: highestSeverity(current.severity, finding.severity),
      required: current.required || finding.required,
      waivable: current.waivable && finding.waivable,
    }));
  }
  return sortHarnessFindings([...byFingerprint.values()]);
}

function defaultProfileFor(request: HarnessRequest): ResolvedHarnessProfile {
  return resolveHarnessProfile({
    id: 'implicit-immutable-floor',
    revision: request.profileRevision,
  });
}

function derivedInvocationId(request: HarnessRequest, profile: ResolvedHarnessProfile): string {
  if (request.invocationId !== undefined && request.invocationId.trim().length > 0) {
    return request.invocationId;
  }

  return stableFingerprint('harness.invocation', {
    trigger: request.trigger,
    actor: request.actor.kind,
    provider: request.actor.provider,
    workspace: request.workspace,
    runId: request.runId,
    nodeAttemptId: request.nodeAttemptId,
    tool: request.tool === undefined ? undefined : {
      name: request.tool.name,
      inputHash: request.tool.inputHash,
      responseHash: request.tool.responseHash,
    },
    profileRevision: request.profileRevision,
    profileHash: profile.hash,
    changes: [...request.changes]
      .map((change) => ({ path: change.path, beforeHash: change.beforeHash, afterHash: change.afterHash }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    command: request.command === undefined ? undefined : {
      executable: request.command.executable,
      argvLength: request.command.argv.length,
    },
  });
}

function resolveExternalChecks(
  profile: ResolvedHarnessProfile,
  executions: readonly HarnessCheckExecution[],
): { readonly findings: readonly HarnessFinding[]; readonly skipped: readonly HarnessSkippedCheck[]; readonly executed: number } {
  const executionMap = executionByRule(executions);
  const findings: HarnessFinding[] = [];
  const skipped: HarnessSkippedCheck[] = [];
  let executed = 0;

  for (const requirement of profile.checks) {
    if (BUILT_IN_RULE_IDS.has(requirement.ruleId)) {
      // The pure built-ins ran in this invocation; they never depend on a
      // provider or external binary and therefore cannot be silently skipped.
      executed += 1;
      continue;
    }

    const execution = executionMap.get(requirement.ruleId);
    if (execution === undefined) {
      skipped.push({
        ruleId: requirement.ruleId,
        reason: skippedReason('missing'),
        allowed: !requirement.required && requirement.allowSkip,
      });
      if (requirement.required) {
        findings.push(noFalseGreenFinding(requirement, 'missing'));
      } else if (!requirement.allowSkip) {
        findings.push(optionalStatusFinding(requirement, 'skipped'));
      }
      continue;
    }

    for (const finding of execution.findings ?? []) {
      findings.push(normalizedExternalFinding(finding, requirement));
    }

    if (execution.status === 'passed' || execution.status === 'failed') {
      executed += 1;
    } else {
      skipped.push({
        ruleId: requirement.ruleId,
        reason: skippedReason(execution.status),
        allowed: !requirement.required && requirement.allowSkip,
      });
    }

    if (execution.status !== 'passed') {
      if (requirement.required) {
        findings.push(noFalseGreenFinding(requirement, execution.status));
      } else if ((execution.findings ?? []).length === 0) {
        findings.push(optionalStatusFinding(requirement, execution.status));
      }
    }
  }

  return Object.freeze({
    findings: sortHarnessFindings(findings),
    skipped: Object.freeze([...skipped].sort((left, right) => left.ruleId.localeCompare(right.ruleId))),
    executed,
  });
}

function outcomeFor(findings: readonly HarnessFinding[]): HarnessOutcome {
  if (findings.some((finding) => finding.required)) return 'block';
  return findings.length === 0 ? 'pass' : 'warn';
}

/**
 * Executes the safety floor plus the profile's reported external-check state.
 * It does not spawn a process, interpolate a shell command, or persist raw
 * prompts, replies, hook payloads, environment values, or changed text.
 */
export function evaluateHarness(
  request: HarnessRequest,
  profile: ResolvedHarnessProfile = defaultProfileFor(request),
  options: HarnessEvaluationOptions = {},
): HarnessResult {
  const immutableFindings = runImmutableSafetyChecks(request);
  const external = resolveExternalChecks(profile, request.checkExecutions ?? []);
  const findings = deduplicateFindings([...immutableFindings, ...external.findings]);
  const waiverResolution = applyHarnessWaivers(findings, request.waivers ?? [], options);

  return Object.freeze({
    invocationId: derivedInvocationId(request, profile),
    outcome: outcomeFor(waiverResolution.unwaived),
    findings,
    unwaivedFindings: waiverResolution.unwaived,
    waivedFindings: waiverResolution.waived,
    requiredChecks: profile.checks.filter((check) => check.required).length,
    executedChecks: external.executed,
    skippedChecks: external.skipped,
    profile,
  });
}

/** Alias with a verb suitable for CLI, hook, and scheduler adapters. */
export const runHarness = evaluateHarness;
