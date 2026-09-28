import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/claudeExecutor.js', () => ({ executeClaudeCLI: vi.fn() }));
vi.mock('../src/utils/codexExecutor.js', () => ({ executeCodexCLI: vi.fn() }));

vi.mock('../src/utils/conversationTurn.js', () => ({
  runConversationalTurn: vi.fn(),
}));

import {
  LEGACY_ORCHESTRATE_NOTICE,
  readGoal,
  runGoal,
  runsRoot,
  saveGoal,
  type GoalRecord,
} from '../src/orchestrator.js';
import { executeClaudeCLI } from '../src/utils/claudeExecutor.js';
import { executeCodexCLI } from '../src/utils/codexExecutor.js';
import { runConversationalTurn } from '../src/utils/conversationTurn.js';

describe('legacy orchestrate privacy migration', () => {
  let temporaryRoot: string;
  let goalsDirectory: string;
  let previousGoalsDirectory: string | undefined;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-orchestrator-'));
    goalsDirectory = path.join(temporaryRoot, 'goals');
    previousGoalsDirectory = process.env.MULTICLI_GOALS_DIR;
    process.env.MULTICLI_GOALS_DIR = goalsDirectory;
    vi.mocked(runConversationalTurn).mockReset();
  });

  afterEach(() => {
    if (previousGoalsDirectory === undefined) {
      delete process.env.MULTICLI_GOALS_DIR;
    } else {
      process.env.MULTICLI_GOALS_DIR = previousGoalsDirectory;
    }
    vi.unstubAllEnvs();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('uses a portable run directory with explicit and environment overrides', () => {
    vi.stubEnv('MULTICLI_RUNS_DIR', undefined);
    expect(runsRoot()).toBe(path.join(os.homedir(), '.multicli', 'runs'));
    vi.stubEnv('MULTICLI_RUNS_DIR', '/tmp/env-runs');
    expect(runsRoot()).toBe('/tmp/env-runs');
    expect(runsRoot('/tmp/explicit-runs')).toBe('/tmp/explicit-runs');
  });

  it.each([['', undefined], ['14400000', 14_400_000]])(
    'uses the configured model timeout for both participants (%s)',
    async (configured, expected) => {
      vi.stubEnv('MULTICLI_ASK_TIMEOUT_MS', configured);
      vi.mocked(executeClaudeCLI).mockResolvedValue({ text: 'continue' });
      vi.mocked(executeCodexCLI).mockResolvedValue({ text: 'continue' });
      vi.mocked(runConversationalTurn).mockImplementation(async request => {
        return (await request.run({})).text;
      });
      await runGoal({
        objective: 'test timeouts',
        maxTurns: 2,
        scratchpadRoot: path.join(temporaryRoot, 'runs'),
      });
      expect(vi.mocked(executeClaudeCLI).mock.lastCall?.[5]?.timeoutMs).toBe(expected);
      expect(vi.mocked(executeCodexCLI).mock.lastCall?.[4]?.timeoutMs).toBe(expected);
      expect(executeClaudeCLI).toHaveBeenCalled();
      expect(executeCodexCLI).toHaveBeenCalled();
    },
  );

  it('redacts an unsafe caller-supplied record before it reaches the goal file', () => {
    const objective = 'RAW OBJECTIVE: rotate every production credential';
    const reply = 'RAW MODEL REPLY: token is sk-aaaaaaaaaaaaaaaa';
    const id = 'aabbccddeeff';
    const unsafe = {
      id,
      objective,
      mode: 'solve',
      status: 'active',
      maxTurns: 3,
      turnsUsed: 1,
      scratchpad: path.join(temporaryRoot, 'scratchpad'),
      conversations: {},
      transcript: [{ participant: 'claude', turn: 1, text: reply }],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as GoalRecord;

    saveGoal(unsafe);

    const onDisk = fs.readFileSync(path.join(goalsDirectory, `${id}.json`), 'utf8');
    expect(onDisk).not.toContain(objective);
    expect(onDisk).not.toContain(reply);
    expect(JSON.parse(onDisk)).toMatchObject({
      objective: '[private objective]',
      privacyVersion: 2,
      transcript: [{
        participant: 'claude',
        turn: 1,
        text: '[reply not retained]',
        completionDeclared: false,
      }],
    });
    expect(readGoal(id)).toMatchObject({
      objective: '[private objective]',
      transcript: [{ participant: 'claude', turn: 1, completionDeclared: false }],
    });
  });

  it('migrates legacy raw files and removes only the unchanged generated objective file', () => {
    const id = '112233445566';
    const objective = 'RAW LEGACY OBJECTIVE: repair the release pipeline';
    const reply = 'RAW LEGACY REPLY: detailed model transcript';
    const scratchpad = path.join(temporaryRoot, 'legacy-scratchpad');
    fs.mkdirSync(goalsDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(scratchpad, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(scratchpad, 'OBJECTIVE.md'), `# Objective\n\n${objective}\n`);
    fs.writeFileSync(path.join(goalsDirectory, `${id}.json`), JSON.stringify({
      id,
      objective,
      mode: 'debate',
      status: 'budget_limited',
      maxTurns: 2,
      turnsUsed: 2,
      scratchpad,
      conversations: {},
      transcript: [{ participant: 'codex', turn: 1, text: reply }],
      createdAt: 1,
      updatedAt: 2,
    }), { mode: 0o644 });

    const migrated = readGoal(id);
    const onDisk = fs.readFileSync(path.join(goalsDirectory, `${id}.json`), 'utf8');

    expect(migrated).toMatchObject({
      id,
      objective: '[private objective]',
      privacyVersion: 2,
      transcript: [{ participant: 'codex', turn: 1, completionDeclared: false }],
    });
    expect(onDisk).not.toContain(objective);
    expect(onDisk).not.toContain(reply);
    expect(fs.existsSync(path.join(scratchpad, 'OBJECTIVE.md'))).toBe(false);
    expect(fs.statSync(path.join(goalsDirectory, `${id}.json`)).mode & 0o077).toBe(0);
  });

  it('keeps a live objective and model reply out of both the goal record and scratchpad', async () => {
    const objective = 'RAW LIVE OBJECTIVE: build the hidden launch checklist';
    const reply = 'RAW LIVE MODEL REPLY: do not retain this sentence';
    vi.mocked(runConversationalTurn).mockResolvedValue(reply);
    const events: string[] = [];

    const goal = await runGoal({
      objective,
      maxTurns: 1,
      scratchpadRoot: path.join(temporaryRoot, 'runs'),
      onEvent: (event) => events.push(event),
    });
    const onDisk = fs.readFileSync(path.join(goalsDirectory, `${goal.id}.json`), 'utf8');

    expect(goal.status).toBe('budget_limited');
    expect(onDisk).not.toContain(objective);
    expect(onDisk).not.toContain(reply);
    expect(JSON.stringify(goal)).not.toContain(objective);
    expect(JSON.stringify(goal)).not.toContain(reply);
    expect(goal.transcript).toEqual([expect.objectContaining({
      participant: 'claude',
      turn: 1,
      completionDeclared: false,
    })]);
    expect(fs.existsSync(path.join(goal.scratchpad, 'OBJECTIVE.md'))).toBe(false);
    expect(events).toContain(LEGACY_ORCHESTRATE_NOTICE);
    expect(events.join('\n')).toContain(reply); // live caller output, never durable storage
  });

  it('recommends Studio for new durable workflows', () => {
    expect(LEGACY_ORCHESTRATE_NOTICE).toContain('multicli studio');
    expect(LEGACY_ORCHESTRATE_NOTICE).toContain('Start-Luna-Build-Council');
  });
});
