import { describe, expect, it, vi } from 'vitest';

import {
  MULTICLI_REPOSITORY_CHECKS,
  runRepositoryHarness,
} from '../../src/harness/repository.js';
import {
  SOURCE_LINE_BLOCKING_RULE_ID,
  SOURCE_LINE_WARNING_RULE_ID,
  type RepositorySourceLineReport,
} from '../../src/harness/sourceLines.js';

const cleanSourceReport: RepositorySourceLineReport = {
  filesScanned: 10,
  warningFindings: [],
  blockingFindings: [],
};

describe('repository harness adapter', () => {
  it('passes only when every required repository check passes', async () => {
    const runCheck = vi.fn(async () => ({ status: 'passed' as const, durationMs: 5 }));
    const report = await runRepositoryHarness({
      workspace: '/workspace/multicli',
      trigger: 'pre_push',
      runCheck,
      inspectSourceLines: () => cleanSourceReport,
    });

    expect(report.result.outcome).toBe('pass');
    expect(report.checks).toHaveLength(MULTICLI_REPOSITORY_CHECKS.length + 2);
    expect(runCheck).toHaveBeenCalledWith(
      'repo.types',
      expect.objectContaining({
        executable: expect.stringMatching(/^npm(?:\.cmd)?$/),
        argv: ['run', 'lint'],
        cwd: '/workspace/multicli',
      }),
      expect.any(Number),
    );
  });

  it('blocks on failed, timed-out, unavailable, or missing required checks', async () => {
    const statuses = ['passed', 'timed_out', 'unavailable'] as const;
    let index = 0;
    const report = await runRepositoryHarness({
      workspace: '/workspace/multicli',
      runCheck: async () => ({ status: statuses[index++], durationMs: 10 }),
      inspectSourceLines: () => cleanSourceReport,
    });

    expect(report.result.outcome).toBe('block');
    expect(report.result.unwaivedFindings.some(
      finding => finding.ruleId === 'harness.no-false-green',
    )).toBe(true);
    expect(report.checks.map(check => check.status)).toEqual(['passed', 'passed', ...statuses]);
  });

  it('returns only status metadata and never command output', async () => {
    const report = await runRepositoryHarness({
      workspace: '/workspace/multicli',
      runCheck: async () => ({ status: 'failed', durationMs: 1 }),
      inspectSourceLines: () => cleanSourceReport,
    });
    expect(JSON.stringify(report)).not.toContain('"stdout":');
    expect(JSON.stringify(report)).not.toContain('"stderr":');
  });

  it('warns at 400 lines and blocks at 600 lines', async () => {
    const finding = (ruleId: string, required: boolean) => ({
      ruleId,
      severity: required ? 'error' as const : 'warning' as const,
      path: 'src/large.ts',
      line: required ? 600 : 400,
      message: 'file is too large',
      repair: 'split it',
      fingerprint: `${ruleId}-fingerprint`,
      required,
      waivable: false,
    });
    const run = (sourceReport: RepositorySourceLineReport) => runRepositoryHarness({
      workspace: '/workspace/multicli',
      runCheck: async () => ({ status: 'passed', durationMs: 1 }),
      inspectSourceLines: () => sourceReport,
    });

    const warning = await run({
      filesScanned: 1,
      warningFindings: [finding(SOURCE_LINE_WARNING_RULE_ID, false)],
      blockingFindings: [],
    });
    const blocker = await run({
      filesScanned: 1,
      warningFindings: [],
      blockingFindings: [finding(SOURCE_LINE_BLOCKING_RULE_ID, true)],
    });

    expect(warning.result.outcome).toBe('warn');
    expect(blocker.result.outcome).toBe('block');
  });

  it('fails closed when the source-line inspector is unavailable', async () => {
    const report = await runRepositoryHarness({
      workspace: '/workspace/multicli',
      runCheck: async () => ({ status: 'passed', durationMs: 1 }),
      inspectSourceLines: () => { throw new Error('scanner unavailable'); },
    });

    expect(report.result.outcome).toBe('block');
    expect(report.result.unwaivedFindings.some(
      finding => finding.ruleId === 'harness.no-false-green',
    )).toBe(true);
  });
});
