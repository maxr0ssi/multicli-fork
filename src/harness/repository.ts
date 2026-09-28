import { spawn } from 'node:child_process';

import { runHarness } from './engine.js';
import { resolveHarnessProfile } from './policy.js';
import {
  inspectRepositorySourceLines,
  SOURCE_LINE_BLOCKING_RULE_ID,
  SOURCE_LINE_WARNING_RULE_ID,
  type RepositorySourceLineInspector,
} from './sourceLines.js';
import type {
  HarnessCheckExecution,
  HarnessCheckStatus,
  HarnessResult,
  HarnessTrigger,
  StructuredCommand,
} from './types.js';

export const MULTICLI_REPOSITORY_CHECKS = [
  { ruleId: 'repo.types', label: 'TypeScript', argv: ['run', 'lint'] },
  { ruleId: 'repo.build', label: 'Build', argv: ['run', 'build'] },
  { ruleId: 'repo.tests', label: 'Tests', argv: ['test'] },
] as const;

export interface RepositoryCheckSummary {
  ruleId: string;
  label: string;
  status: HarnessCheckStatus;
  durationMs: number;
}

export interface RepositoryHarnessReport {
  result: HarnessResult;
  checks: readonly RepositoryCheckSummary[];
  startedAt: string;
  completedAt: string;
}

export type RepositoryCheckRunner = (
  ruleId: string,
  command: StructuredCommand,
  timeoutMs: number,
) => Promise<{ status: HarnessCheckStatus; durationMs: number }>;

function npmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

export async function runStructuredRepositoryCheck(
  _ruleId: string,
  command: StructuredCommand,
  timeoutMs: number,
): Promise<{ status: HarnessCheckStatus; durationMs: number }> {
  const startedAt = Date.now();
  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    const child = spawn(command.executable, [...command.argv], {
      cwd: command.cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const finish = (status: HarnessCheckStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, durationMs: Date.now() - startedAt });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          if (process.platform === 'win32') child.kill('SIGTERM');
          else process.kill(-child.pid, 'SIGTERM');
        } catch {
          // The process may already have exited between the timer and signal.
        }
      }
      finish('timed_out');
    }, timeoutMs);
    timer.unref();

    child.once('error', () => finish('unavailable'));
    child.once('close', code => finish(timedOut ? 'timed_out' : code === 0 ? 'passed' : 'failed'));
  });
}

export async function runRepositoryHarness(options: {
  workspace: string;
  trigger?: HarnessTrigger;
  timeoutMs?: number;
  runCheck?: RepositoryCheckRunner;
  inspectSourceLines?: RepositorySourceLineInspector;
}): Promise<RepositoryHarnessReport> {
  const startedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const runCheck = options.runCheck ?? runStructuredRepositoryCheck;
  const executable = npmExecutable();
  const commands: StructuredCommand[] = MULTICLI_REPOSITORY_CHECKS.map(check => ({
    executable,
    argv: [...check.argv],
    cwd: options.workspace,
  }));
  const profile = resolveHarnessProfile({
    id: 'multicli-repository-harness',
    revision: 'v1',
    workspace: {
      id: 'multicli-self-hosting',
      revision: 'v1',
      checks: [
        {
          ruleId: SOURCE_LINE_WARNING_RULE_ID,
          required: false,
          allowSkip: false,
          severity: 'warning' as const,
          waivable: false,
        },
        {
          ruleId: SOURCE_LINE_BLOCKING_RULE_ID,
          required: true,
          allowSkip: false,
          severity: 'error' as const,
          waivable: false,
        },
        ...MULTICLI_REPOSITORY_CHECKS.map(check => ({
          ruleId: check.ruleId,
          required: true,
          allowSkip: false,
          severity: 'error' as const,
          waivable: false,
        })),
      ],
      limits: { maxDurationMs: timeoutMs, maxOutputBytes: 0 },
      commands,
    },
  });

  const checks: RepositoryCheckSummary[] = [];
  const executions: HarnessCheckExecution[] = [];
  const inspectSourceLines = options.inspectSourceLines ?? inspectRepositorySourceLines;
  const sourceStartedAt = Date.now();
  try {
    const sourceReport = await inspectSourceLines(options.workspace);
    const durationMs = Date.now() - sourceStartedAt;
    checks.push(
      {
        ruleId: SOURCE_LINE_WARNING_RULE_ID,
        label: 'Source LOC warning (>=400)',
        status: 'passed',
        durationMs,
      },
      {
        ruleId: SOURCE_LINE_BLOCKING_RULE_ID,
        label: 'Source LOC blocker (>=600)',
        status: 'passed',
        durationMs,
      },
    );
    executions.push(
      {
        ruleId: SOURCE_LINE_WARNING_RULE_ID,
        status: 'passed',
        findings: sourceReport.warningFindings,
      },
      {
        ruleId: SOURCE_LINE_BLOCKING_RULE_ID,
        status: 'passed',
        findings: sourceReport.blockingFindings,
      },
    );
  } catch {
    const durationMs = Date.now() - sourceStartedAt;
    checks.push(
      {
        ruleId: SOURCE_LINE_WARNING_RULE_ID,
        label: 'Source LOC warning (>=400)',
        status: 'unavailable',
        durationMs,
      },
      {
        ruleId: SOURCE_LINE_BLOCKING_RULE_ID,
        label: 'Source LOC blocker (>=600)',
        status: 'unavailable',
        durationMs,
      },
    );
    executions.push(
      { ruleId: SOURCE_LINE_WARNING_RULE_ID, status: 'unavailable' },
      { ruleId: SOURCE_LINE_BLOCKING_RULE_ID, status: 'unavailable' },
    );
  }
  for (let index = 0; index < MULTICLI_REPOSITORY_CHECKS.length; index += 1) {
    const check = MULTICLI_REPOSITORY_CHECKS[index];
    const execution = await runCheck(check.ruleId, commands[index], timeoutMs);
    checks.push({
      ruleId: check.ruleId,
      label: check.label,
      status: execution.status,
      durationMs: execution.durationMs,
    });
    executions.push({ ruleId: check.ruleId, status: execution.status });
  }

  const result = runHarness({
    trigger: options.trigger ?? 'node_exit',
    actor: { kind: options.trigger === 'ci' ? 'ci' : 'user' },
    workspace: options.workspace,
    changes: [],
    profileRevision: profile.revision,
    mcp: {
      transport: 'stdio',
      stdoutMode: 'protocol-only',
      forwardOperationalOutputToStdout: false,
      logging: {
        prompts: false,
        replies: false,
        toolArguments: false,
        commandOutput: false,
      },
    },
    checkExecutions: executions,
  }, profile);

  return {
    result,
    checks,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
