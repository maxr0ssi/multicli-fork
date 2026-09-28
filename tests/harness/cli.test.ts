import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { LocalControlPlane } from '../../src/controlPlane/controlPlane.js';
import { handleHarnessCommand } from '../../src/harness/cli.js';
import { runRepositoryHarness } from '../../src/harness/repository.js';
import { SOURCE_LINE_WARNING_RULE_ID } from '../../src/harness/sourceLines.js';
import { createInMemoryRunLedger } from '../../src/persistence/runLedger.js';

describe('harness CLI adapter', () => {
  it('records the complete harness lifecycle in the durable run ledger', async () => {
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const output: string[] = [];
    const exitCode = await handleHarnessCommand(
      ['run', '--trigger', 'pre-push'],
      loadConfig({}),
      {
        controlPlane,
        workspace: '/workspace/multicli',
        write: value => output.push(value),
        run: options => runRepositoryHarness({
          ...options,
          runCheck: async () => ({ status: 'passed', durationMs: 2 }),
          inspectSourceLines: () => ({
            filesScanned: 1,
            warningFindings: [],
            blockingFindings: [],
          }),
        }),
      },
    );

    const run = controlPlane.listRuns(1)[0];
    expect(exitCode).toBe(0);
    expect(run.status).toBe('completed');
    expect(controlPlane.ledger.listEvents(run.id).map(event => event.type)).toEqual([
      'run.started',
      'harness.started',
      'harness.completed',
      'run.completed',
    ]);
    expect(output.join('')).toContain('repository harness: PASS');
    controlPlane.close();
  });

  it('returns a blocking exit code without a false green', async () => {
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const exitCode = await handleHarnessCommand(['run'], loadConfig({}), {
      controlPlane,
      write: () => {},
      run: options => runRepositoryHarness({
        ...options,
        runCheck: async () => ({ status: 'failed', durationMs: 1 }),
        inspectSourceLines: () => ({
          filesScanned: 1,
          warningFindings: [],
          blockingFindings: [],
        }),
      }),
    });

    expect(exitCode).toBe(1);
    expect(controlPlane.listRuns(1)[0].status).toBe('failed');
    controlPlane.close();
  });

  it('prints an advisory LOC warning without a blocking exit code', async () => {
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const output: string[] = [];
    const exitCode = await handleHarnessCommand(['run'], loadConfig({}), {
      controlPlane,
      workspace: '/workspace/multicli',
      write: value => output.push(value),
      run: options => runRepositoryHarness({
        ...options,
        runCheck: async () => ({ status: 'passed', durationMs: 1 }),
        inspectSourceLines: () => ({
          filesScanned: 1,
          blockingFindings: [],
          warningFindings: [{
            ruleId: SOURCE_LINE_WARNING_RULE_ID,
            severity: 'warning',
            path: 'src/large.ts',
            line: 400,
            message: 'source file reached 400 lines',
            repair: 'split it',
            fingerprint: 'loc-warning',
            required: false,
            waivable: false,
          }],
        }),
      }),
    });

    expect(exitCode).toBe(0);
    expect(output.join('')).toContain('repository harness: WARN');
    expect(output.join('')).toContain('Warnings: 1');
    expect(output.join('')).not.toContain('Blocking findings');
    controlPlane.close();
  });

  it('normalizes Claude and Codex write hooks without echoing sensitive content', async () => {
    const config = loadConfig({});
    const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
    const claudeOutput: string[] = [];
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
    const claudeExit = await handleHarnessCommand([
      'hook',
      '--provider',
      'claude',
      '--trigger',
      'post-edit',
    ], config, {
      workspace: '/workspace/multicli',
      controlPlane,
      write: value => claudeOutput.push(value),
      hookPayload: {
        tool_name: 'Write',
        tool_input: { file_path: 'src/config.ts', content: `token=${secret}` },
      },
    });
    const codexOutput: string[] = [];
    const codexExit = await handleHarnessCommand([
      'hook',
      '--provider=codex',
      '--trigger=post-edit',
    ], config, {
      workspace: '/workspace/multicli',
      controlPlane,
      write: value => codexOutput.push(value),
      hookPayload: {
        tool_name: 'apply_patch',
        input: '*** Begin Patch\n*** Update File: CODEX.md\n+unsafe\n*** End Patch',
      },
    });

    expect(claudeExit).toBe(2);
    expect(claudeOutput.join('')).toContain('secrets.detected');
    expect(claudeOutput.join('')).not.toContain(secret);
    expect(codexExit).toBe(2);
    expect(codexOutput.join('')).toContain('files.protected-symlink-alias');
    expect(controlPlane.listRuns()).toHaveLength(2);
    controlPlane.close();
  });

  it('fails closed for an unknown post-edit mutation payload', async () => {
    await expect(handleHarnessCommand([
      'hook', '--provider', 'claude', '--trigger', 'post-edit',
    ], loadConfig({}), {
      workspace: '/workspace/multicli',
      hookPayload: { tool_name: 'FutureMutationTool', tool_input: { path: 'src/a.ts' } },
    })).rejects.toThrow(/refusing to report a false green/i);
  });
});
