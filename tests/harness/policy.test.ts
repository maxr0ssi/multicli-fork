import { describe, expect, it } from 'vitest';

import {
  IMMUTABLE_SAFETY_CHECKS,
  isStructuredCommand,
  resolveHarnessProfile,
} from '../../src/harness/index.js';

describe('harness policy resolution', () => {
  it('keeps the immutable floor required, non-waivable, and frozen', () => {
    const profile = resolveHarnessProfile({
      id: 'personal-defaults',
      revision: 'profile-r1',
      userGlobal: {
        id: 'user',
        revision: 'u1',
        checks: [{
          ruleId: 'mcp.stdout.protocol-only',
          required: false,
          waivable: true,
          severity: 'info',
        }],
        limits: { maxDurationMs: 60_000, maxOutputBytes: 8_000 },
      },
      workspace: {
        id: 'workspace',
        revision: 'w1',
        limits: { maxDurationMs: 30_000, maxSubjects: 20 },
      },
      workflow: {
        id: 'workflow',
        revision: 'wf1',
        allowRunOverride: true,
        limits: { maxDurationMs: 45_000 },
      },
      runOverride: {
        id: 'run',
        revision: 'run1',
        // A run override is limited to numerical reductions; this attempted
        // policy edit must not appear in the resolved profile.
        checks: [{ ruleId: 'style.optional', required: false }],
        limits: { maxDurationMs: 15_000 },
      },
    });

    const mcpRule = profile.checks.find((check) => check.ruleId === 'mcp.stdout.protocol-only');
    expect(mcpRule).toMatchObject({
      required: true,
      allowSkip: false,
      waivable: false,
      severity: 'critical',
      source: 'user_global',
    });
    expect(profile.checks.some((check) => check.ruleId === 'style.optional')).toBe(false);
    expect(profile.limits).toEqual({
      maxDurationMs: 15_000,
      maxOutputBytes: 8_000,
      maxSubjects: 20,
    });
    expect(profile.layers.map((layer) => layer.source)).toEqual([
      'built_in', 'user_global', 'workspace', 'workflow', 'run_override',
    ]);
    expect(profile.checks.filter((check) => check.required)).toHaveLength(IMMUTABLE_SAFETY_CHECKS.length);
    expect(Object.isFrozen(IMMUTABLE_SAFETY_CHECKS)).toBe(true);
    expect(Object.isFrozen(IMMUTABLE_SAFETY_CHECKS[0])).toBe(true);
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it('ignores a run override unless the published workflow permits it', () => {
    const profile = resolveHarnessProfile({
      id: 'locked-workflow',
      revision: 'r1',
      workflow: {
        id: 'workflow',
        revision: 'wf1',
        limits: { maxDurationMs: 20_000 },
      },
      runOverride: {
        id: 'unapproved-run-override',
        revision: 'run1',
        limits: { maxDurationMs: 1 },
      },
    });

    expect(profile.limits.maxDurationMs).toBe(20_000);
    expect(profile.layers.some((layer) => layer.source === 'run_override')).toBe(false);
  });

  it('produces a stable, secret-safe profile hash regardless of check declaration order', () => {
    const makeProfile = (checks: readonly { ruleId: string; required: boolean }[], apiKey: string) => resolveHarnessProfile({
      id: 'hash-profile',
      revision: 'r1',
      workspace: {
        id: 'workspace',
        revision: 'w1',
        checks,
        commands: [{
          executable: 'node',
          argv: ['scripts/check.mjs', '--api-key', apiKey],
          env: { SERVICE_TOKEN: apiKey },
        }],
      },
    });

    const first = makeProfile([
      { ruleId: 'tests.focused', required: true },
      { ruleId: 'schema', required: false },
    ], 'opaque-literal-a');
    const second = makeProfile([
      { ruleId: 'schema', required: false },
      { ruleId: 'tests.focused', required: true },
    ], 'opaque-literal-b');

    expect(first.hash).toBe(second.hash);
    expect(JSON.stringify(first)).not.toContain('opaque-literal-a');
    expect(first.commands[0].argv).toContain('<redacted>');
    expect(first.commands[0].env?.SERVICE_TOKEN).toBe('<redacted>');
  });

  it('accepts only executable-plus-argv command contracts', () => {
    expect(isStructuredCommand({ executable: 'npm', argv: ['run', 'lint'] })).toBe(true);
    expect(isStructuredCommand({ executable: 'npm run lint' })).toBe(false);
    // Shell-looking text is still only a literal argv value. This core never
    // invokes a shell or interpolates it.
    expect(isStructuredCommand({ executable: 'node', argv: ['-e', '$(not-a-shell-command)'] })).toBe(true);
  });
});
