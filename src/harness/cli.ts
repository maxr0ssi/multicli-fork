import type { MultiCliConfig } from '../config.js';
import { LocalControlPlane } from '../controlPlane/controlPlane.js';
import { SqliteRunLedger } from '../persistence/runLedger.js';
import { runHarness } from './engine.js';
import { normalizeHookPayload } from './hooks.js';
import {
  runRepositoryHarness,
  type RepositoryHarnessReport,
} from './repository.js';
import { SOURCE_LINE_BLOCKING_RULE_ID, SOURCE_LINE_WARNING_RULE_ID } from './sourceLines.js';
import { HARNESS_TRIGGERS, type HarnessTrigger } from './types.js';

async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error('Harness hook payload exceeds 1 MiB');
    chunks.push(buffer);
  }
  const source = Buffer.concat(chunks).toString('utf8').trim();
  if (!source) throw new Error('Harness hook requires a JSON payload on stdin');
  return JSON.parse(source) as unknown;
}

function optionValue(args: string[], name: string): string | undefined {
  const equals = args.find(argument => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseTrigger(args: string[]): HarnessTrigger {
  const equals = args.find(argument => argument.startsWith('--trigger='));
  const flagIndex = args.indexOf('--trigger');
  const raw = equals?.slice('--trigger='.length)
    ?? (flagIndex >= 0 ? args[flagIndex + 1] : undefined)
    ?? 'node_exit';
  const normalized = raw.replaceAll('-', '_') as HarnessTrigger;
  if (!HARNESS_TRIGGERS.includes(normalized)) {
    throw new Error(`Unknown harness trigger: ${raw}`);
  }
  return normalized;
}

export async function handleHarnessCommand(
  args: string[],
  config: MultiCliConfig,
  options: {
    controlPlane?: LocalControlPlane;
    run?: typeof runRepositoryHarness;
    write?: (value: string) => void;
    workspace?: string;
    hookPayload?: unknown;
  } = {},
): Promise<number> {
  const [subcommand = 'run'] = args;
  if (subcommand === 'hook') {
    const provider = optionValue(args, '--provider');
    if (provider !== 'claude' && provider !== 'codex') {
      throw new Error('Harness hook requires --provider claude or --provider codex');
    }
    const trigger = parseTrigger(args);
    const workspace = options.workspace ?? process.cwd();
    const payload = options.hookPayload ?? await readStdinJson();
    const normalized = normalizeHookPayload(provider, payload);
    if (trigger === 'post_edit' && normalized === undefined) {
      throw new Error('Unsupported mutation hook payload; refusing to report a false green.');
    }
    const result = runHarness({
      trigger,
      actor: { kind: provider, provider },
      workspace,
      changes: normalized?.changes ?? [],
      profileRevision: 'immutable-floor-v1',
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
    });
    const ownControlPlane = options.controlPlane === undefined;
    const controlPlane = options.controlPlane
      ?? new LocalControlPlane(new SqliteRunLedger(config.runStorePath));
    const revision = controlPlane.publishWorkflow({
      workflowId: 'multicli-provider-hook-harness',
      definition: {
        id: 'multicli-provider-hook-harness',
        name: 'Claude and Codex Hook Harness',
        provider,
        trigger,
      },
    });
    const runId = controlPlane.startRun({
      workflowRevisionId: revision.id,
      workspace,
      runInput: { provider, trigger, workspace },
    }).run.id;
    controlPlane.appendEvent(runId, 'harness.completed', {
      invocationId: result.invocationId,
      provider,
      trigger,
      outcome: result.outcome,
      findings: result.unwaivedFindings.map(finding => ({
        ruleId: finding.ruleId,
        severity: finding.severity,
        path: finding.path,
        line: finding.line,
        message: finding.message,
        repair: finding.repair,
        fingerprint: finding.fingerprint,
      })),
    });
    controlPlane.appendEvent(
      runId,
      result.outcome === 'block' || result.outcome === 'error'
        ? 'run.failed'
        : 'run.completed',
      { outcome: result.outcome },
    );
    if (ownControlPlane) controlPlane.close();
    const write = options.write ?? (value => process.stdout.write(value));
    write(`${JSON.stringify({
      invocationId: result.invocationId,
      outcome: result.outcome,
      findings: result.unwaivedFindings.map(finding => ({
        ruleId: finding.ruleId,
        severity: finding.severity,
        path: finding.path,
        line: finding.line,
        message: finding.message,
        repair: finding.repair,
        fingerprint: finding.fingerprint,
      })),
    })}\n`);
    return result.outcome === 'block' || result.outcome === 'error' ? 2 : 0;
  }
  if (subcommand !== 'run') {
    throw new Error(`Unknown harness command: ${subcommand}. Use: multicli harness run or multicli harness hook`);
  }

  const trigger = parseTrigger(args);
  const workspace = options.workspace ?? process.cwd();
  const ownControlPlane = options.controlPlane === undefined;
  const controlPlane = options.controlPlane
    ?? new LocalControlPlane(new SqliteRunLedger(config.runStorePath));
  const write = options.write ?? (value => process.stdout.write(value));
  const revision = controlPlane.publishWorkflow({
    workflowId: 'multicli-repository-harness',
    definition: {
      id: 'multicli-repository-harness',
      name: 'Multi-CLI Repository Harness',
      trigger,
      checks: [
        SOURCE_LINE_WARNING_RULE_ID,
        SOURCE_LINE_BLOCKING_RULE_ID,
        'repo.types',
        'repo.build',
        'repo.tests',
      ],
    },
  });
  const snapshot = controlPlane.startRun({
    workflowRevisionId: revision.id,
    workspace,
    runInput: { trigger, workspace },
  });
  const runId = snapshot.run.id;
  controlPlane.appendEvent(runId, 'harness.started', { trigger, workspace });

  try {
    const report: RepositoryHarnessReport = await (options.run ?? runRepositoryHarness)({
      workspace,
      trigger,
    });
    controlPlane.appendEvent(runId, 'harness.completed', {
      invocationId: report.result.invocationId,
      outcome: report.result.outcome,
      checks: report.checks,
      findings: report.result.unwaivedFindings.map(finding => ({
        ruleId: finding.ruleId,
        severity: finding.severity,
        message: finding.message,
        fingerprint: finding.fingerprint,
      })),
    });
    controlPlane.appendEvent(
      runId,
      report.result.outcome === 'block' || report.result.outcome === 'error'
        ? 'run.failed'
        : 'run.completed',
      { outcome: report.result.outcome },
    );

    write(`Multi-CLI repository harness: ${report.result.outcome.toUpperCase()}\n`);
    for (const check of report.checks) {
      write(`- ${check.label}: ${check.status} (${check.durationMs}ms)\n`);
    }
    const blockingFindings = report.result.unwaivedFindings.filter(finding => finding.required);
    const warnings = report.result.unwaivedFindings.filter(finding => !finding.required);
    if (blockingFindings.length) write(`Blocking findings: ${blockingFindings.length}\n`);
    if (warnings.length) write(`Warnings: ${warnings.length}\n`);
    return report.result.outcome === 'block' || report.result.outcome === 'error' ? 1 : 0;
  } catch (error) {
    controlPlane.appendEvent(runId, 'harness.failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    controlPlane.appendEvent(runId, 'run.failed', { reason: 'harness adapter failed' });
    throw error;
  } finally {
    if (ownControlPlane) controlPlane.close();
  }
}
