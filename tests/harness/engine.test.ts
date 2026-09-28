import { describe, expect, it } from 'vitest';

import {
  evaluateHarness,
  IMMUTABLE_SAFETY_CHECKS,
  resolveHarnessProfile,
  type HarnessRequest,
} from '../../src/harness/index.js';

const NOW = new Date('2026-08-09T12:00:00.000Z');

function request(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    trigger: 'post_edit',
    actor: { kind: 'codex' },
    workspace: '/workspace/project',
    changes: [],
    profileRevision: 'profile-r1',
    ...overrides,
  };
}

describe('deterministic harness engine', () => {
  it('blocks immutable safety findings even when a matching waiver is supplied', () => {
    const profile = resolveHarnessProfile({ id: 'floor', revision: 'r1' });
    const unsafe = request({
      changes: [
        {
          path: 'CLAUDE.md',
          isSymlink: true,
          resolvedPath: '/workspace/project/AGENTS.md',
        },
        {
          path: 'src/token.ts',
          addedText: 'const apiKey = "sk-aaaaaaaaaaaaaaaa";',
        },
      ],
      command: {
        executable: 'codex',
        argv: ['exec', 'resume', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '--full-auto'],
        env: { OPENAI_API_KEY: 'sk-bbbbbbbbbbbbbbbb' },
      },
      mcp: {
        transport: 'stdio',
        stdoutMode: 'mixed',
        forwardOperationalOutputToStdout: true,
        logging: { prompts: true },
      },
      resume: {
        enabled: true,
        pinned: {
          model: 'gpt-5.6-luna',
          sandbox: 'read-only',
          workspace: '/workspace/project',
        },
        requested: {
          model: 'gpt-5.6-luna',
          sandbox: 'workspace-write',
          workspace: '/workspace/project',
        },
      },
    });
    const initial = evaluateHarness(unsafe, profile, { now: NOW });
    const result = evaluateHarness({
      ...unsafe,
      waivers: initial.findings.map((finding) => ({
        fingerprint: finding.fingerprint,
        reason: 'not allowed for an immutable floor test',
        actor: 'test-user',
        approvedBy: 'test-admin',
        expiresAt: '2027-01-01T00:00:00.000Z',
      })),
    }, profile, { now: NOW });

    expect(result.outcome).toBe('block');
    expect(result.waivedFindings).toHaveLength(0);
    expect(result.requiredChecks).toBe(IMMUTABLE_SAFETY_CHECKS.length);
    expect(result.executedChecks).toBe(IMMUTABLE_SAFETY_CHECKS.length);
    expect(new Set(result.findings.map((finding) => finding.ruleId))).toEqual(new Set([
      'secrets.detected',
      'files.protected-symlink-alias',
      'mcp.stdout.protocol-only',
      'logging.no-content-by-default',
      'provider.resume.dangerous-flags',
      'provider.resume.pinned',
    ]));
    expect(result.findings.every((finding) => finding.required && !finding.waivable)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sk-aaaaaaaa');
    expect(JSON.stringify(result)).not.toContain('sk-bbbbb');
  });

  it('uses a stable secret fingerprint without retaining the secret value', () => {
    const profile = resolveHarnessProfile({ id: 'floor', revision: 'r1' });
    const first = evaluateHarness(request({
      changes: [{ path: 'src/config.ts', addedText: 'const key = "sk-aaaaaaaaaaaaaaaa";' }],
    }), profile, { now: NOW });
    const second = evaluateHarness(request({
      changes: [{ path: 'src/config.ts', addedText: 'const key = "sk-bbbbbbbbbbbbbbbb";' }],
    }), profile, { now: NOW });

    const firstSecret = first.findings.find((finding) => finding.ruleId === 'secrets.detected');
    const secondSecret = second.findings.find((finding) => finding.ruleId === 'secrets.detected');
    expect(firstSecret?.fingerprint).toBe(secondSecret?.fingerprint);
    expect(JSON.stringify(first)).not.toContain('sk-aaaaaaaa');
  });

  it('cannot report a green gate when a required external check is missing or skipped', () => {
    const profile = resolveHarnessProfile({
      id: 'required-check',
      revision: 'r1',
      workflow: {
        id: 'workflow',
        revision: 'wf1',
        checks: [{ ruleId: 'tests.focused', required: true }],
      },
    });
    const missing = evaluateHarness(request(), profile, { now: NOW });
    const skipped = evaluateHarness(request({
      checkExecutions: [{ ruleId: 'tests.focused', status: 'skipped' }],
    }), profile, { now: NOW });

    for (const result of [missing, skipped]) {
      expect(result.outcome).toBe('block');
      expect(result.executedChecks).toBe(IMMUTABLE_SAFETY_CHECKS.length);
      expect(result.skippedChecks).toContainEqual(expect.objectContaining({
        ruleId: 'tests.focused',
        allowed: false,
      }));
      const falseGreen = result.findings.find((finding) => finding.ruleId === 'harness.no-false-green');
      expect(falseGreen).toMatchObject({ required: true, waivable: false });
    }
  });

  it('allows only a valid exact waiver for a waivable advisory finding', () => {
    const profile = resolveHarnessProfile({
      id: 'advisory',
      revision: 'r1',
      workspace: {
        id: 'workspace',
        revision: 'w1',
        checks: [{ ruleId: 'style.advisory', required: false, waivable: true }],
      },
    });
    const withAdvisory = request({
      checkExecutions: [{
        ruleId: 'style.advisory',
        status: 'failed',
        findings: [{
          ruleId: 'style.advisory',
          severity: 'warning',
          message: 'Format the changed file.',
          repair: 'Run the formatter.',
          fingerprint: 'advisory-format-fingerprint',
          required: false,
          waivable: true,
        }],
      }],
    });
    const warning = evaluateHarness(withAdvisory, profile, { now: NOW });
    const waived = evaluateHarness({
      ...withAdvisory,
      waivers: [{
        fingerprint: 'advisory-format-fingerprint',
        reason: 'Formatter migration is tracked separately.',
        actor: 'max',
        approvedBy: 'max',
        expiresAt: '2026-08-10T00:00:00.000Z',
      }],
    }, profile, { now: NOW });

    expect(warning.outcome).toBe('warn');
    expect(waived.outcome).toBe('pass');
    expect(waived.waivedFindings).toHaveLength(1);
    expect(waived.unwaivedFindings).toHaveLength(0);
  });

  it('recognizes Claude permission bypass flags on a resumed turn', () => {
    const profile = resolveHarnessProfile({ id: 'floor', revision: 'r1' });
    const result = evaluateHarness(request({
      actor: { kind: 'claude' },
      command: {
        executable: 'claude',
        argv: ['--resume', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '--permission-mode=bypassPermissions'],
      },
      resume: {
        enabled: true,
        pinned: { model: 'sonnet', sandbox: 'read-only', workspace: '/workspace/project' },
        requested: { model: 'sonnet', sandbox: 'read-only', workspace: '/workspace/project' },
      },
    }), profile, { now: NOW });

    expect(result.findings).toContainEqual(expect.objectContaining({
      ruleId: 'provider.resume.dangerous-flags',
      required: true,
      waivable: false,
    }));
  });
});
