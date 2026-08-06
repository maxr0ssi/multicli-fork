import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executeClaudeCLI } from './utils/claudeExecutor.js';
import { executeCodexCLI } from './utils/codexExecutor.js';
import { runConversationalTurn } from './utils/conversationTurn.js';

/**
 * Runs two backend CLIs against one objective until they agree it is met or the
 * turn budget runs out.
 *
 * Each participant keeps its own persistent conversation, so it remembers its
 * own earlier turns natively instead of having a transcript replayed at it. The
 * only thing they share is a scratchpad directory, which is also the only place
 * either of them is allowed to write.
 */

const GOAL_DIR = path.join(os.homedir(), '.multicli', 'goals');
const GOAL_ID_PATTERN = /^[0-9a-f]{12}$/;

// The agents declare completion in their own words, so the signal has to be
// something they will not emit while merely discussing the work.
const DONE_MARKER = 'GOAL_COMPLETE';

export type GoalStatus = 'active' | 'complete' | 'budget_limited' | 'failed';
export type Participant = 'codex' | 'claude';
export type RunMode = 'debate' | 'solve';

export interface GoalRecord {
  id: string;
  objective: string;
  mode: RunMode;
  status: GoalStatus;
  maxTurns: number;
  turnsUsed: number;
  scratchpad: string;
  conversations: Partial<Record<Participant, string>>;
  transcript: { participant: Participant; turn: number; text: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface RunOptions {
  objective: string;
  mode?: RunMode;
  maxTurns?: number;
  models?: Partial<Record<Participant, string>>;
  /** Reasoning effort per participant, e.g. codex: 'max'. */
  efforts?: Partial<Record<Participant, string>>;
  /** Where the shared work lands. Defaults to ./multicli-runs/<goalId>. */
  scratchpadRoot?: string;
  onEvent?: (event: string) => void;
}

const DEFAULT_MODELS: Record<Participant, string> = {
  codex: 'gpt-5.6-sol',
  claude: 'sonnet',
};

function goalPath(id: string): string {
  if (!GOAL_ID_PATTERN.test(id)) {
    throw new Error(`Invalid goal id: ${JSON.stringify(id)}`);
  }

  const filePath = path.join(GOAL_DIR, `${id}.json`);
  if (path.dirname(path.resolve(filePath)) !== path.resolve(GOAL_DIR)) {
    throw new Error(`Refusing to escape goal directory: ${id}`);
  }

  return filePath;
}

export function readGoal(id: string): GoalRecord | null {
  try {
    return JSON.parse(fs.readFileSync(goalPath(id), 'utf-8')) as GoalRecord;
  } catch {
    return null;
  }
}

export function saveGoal(goal: GoalRecord): void {
  fs.mkdirSync(GOAL_DIR, { recursive: true, mode: 0o700 });
  goal.updatedAt = Date.now();
  fs.writeFileSync(goalPath(goal.id), JSON.stringify(goal, null, 2), { mode: 0o600 });
}

export function listGoals(): GoalRecord[] {
  try {
    return fs
      .readdirSync(GOAL_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readGoal(f.slice(0, -'.json'.length)))
      .filter((g): g is GoalRecord => g !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/**
 * Where runs are written. One fixed place rather than the current directory:
 * this is a machine-wide tool, and a cwd-relative default scatters artifacts
 * into whichever repo happened to be current when it was launched.
 */
export function runsRoot(override?: string): string {
  return (
    override ??
    process.env.MULTICLI_RUNS_DIR ??
    path.join(os.homedir(), 'Documents', 'Columbia', 'multicli-runs')
  );
}

function createGoal(options: RunOptions): GoalRecord {
  const id = randomBytes(6).toString('hex');
  const scratchpad = path.resolve(runsRoot(options.scratchpadRoot), id);
  fs.mkdirSync(scratchpad, { recursive: true, mode: 0o700 });

  const now = Date.now();
  const goal: GoalRecord = {
    id,
    objective: options.objective,
    mode: options.mode ?? 'debate',
    status: 'active',
    maxTurns: options.maxTurns ?? 6,
    turnsUsed: 0,
    scratchpad,
    conversations: {},
    transcript: [],
    createdAt: now,
    updatedAt: now,
  };

  fs.writeFileSync(
    path.join(scratchpad, 'OBJECTIVE.md'),
    `# Objective\n\n${goal.objective}\n`,
    { mode: 0o600 },
  );

  saveGoal(goal);
  return goal;
}

function scratchpadListing(goal: GoalRecord): string {
  let files: string[];
  try {
    files = fs.readdirSync(goal.scratchpad);
  } catch {
    return '(empty)';
  }

  return files.length ? files.join(', ') : '(empty)';
}

function buildPrompt(goal: GoalRecord, self: Participant, lastFrom: string | undefined): string {
  const other = self === 'codex' ? 'Claude' : 'Codex';
  const role =
    goal.mode === 'debate'
      ? `You are debating ${other}. Argue your position, concede points that are correct, and push back on ones that are not.`
      : `You are working with ${other} to complete the objective. Build on their work rather than repeating it.`;

  const first = goal.turnsUsed === 0;

  return [
    `# Objective\n${goal.objective}`,
    `# Your role\n${role}`,
    `# Shared scratchpad\nThe directory ${goal.scratchpad} is shared with ${other} and is the ONLY place you may write.`,
    `Files currently there: ${scratchpadListing(goal)}.`,
    'Read what is there before answering, and record durable findings there rather than only in prose.',
    lastFrom
      ? `# ${other} just said\n${lastFrom}`
      : first
        ? '# You are opening\nState your position or first step.'
        : '',
    `# Finishing\nWhen the objective is genuinely met and ${other} has agreed, reply with the single line ${DONE_MARKER} plus a one paragraph summary. Do not use that marker otherwise.`,
    'Keep each reply under 200 words.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function takeTurn(
  goal: GoalRecord,
  self: Participant,
  lastFrom: string | undefined,
  models: Record<Participant, string>,
  efforts: Partial<Record<Participant, string>>,
): Promise<string> {
  const model = models[self];
  const handle = goal.conversations[self];
  const conversationId = handle ?? 'new';
  const prompt = buildPrompt(goal, self, lastFrom);

  // cwd is the scratchpad, and write access is granted only there: the agents
  // can exchange artifacts without either of them reaching the wider filesystem.
  const context = { cwd: goal.scratchpad, timeoutMs: 300_000 };

  const text = await runConversationalTurn({
    cli: self,
    conversationId,
    model,
    sandbox: self === 'codex' ? 'workspace-write' : 'n/a',
    cwd: goal.scratchpad,
    presetSessionId: self === 'claude',
    run: ({ startSessionId, resumeSessionId }) =>
      self === 'codex'
        ? executeCodexCLI(prompt, model, 'workspace-write', undefined, context, resumeSessionId,
            { effort: efforts.codex })
        : executeClaudeCLI(
            prompt, model, 'acceptEdits', undefined, undefined, context,
            startSessionId, resumeSessionId,
          ),
  });

  if (!handle) {
    const minted = /Conversation handle: ([0-9a-f]{16})/.exec(text)?.[1];
    if (minted) goal.conversations[self] = minted;
  }

  return text.replace(/\n\n---\nConversation handle:.*$/s, '').trim();
}

export async function runGoal(options: RunOptions): Promise<GoalRecord> {
  const goal = createGoal(options);
  const models = { ...DEFAULT_MODELS, ...options.models };
  const efforts = options.efforts ?? {};
  const emit = options.onEvent ?? (() => {});

  emit(`goal ${goal.id} started: ${goal.objective}`);
  emit(`scratchpad: ${goal.scratchpad}`);
  emit(
    `participants: claude=${models.claude}${efforts.claude ? `/${efforts.claude}` : ''}, ` +
      `codex=${models.codex}${efforts.codex ? `/${efforts.codex}` : ''}`,
  );

  const order: Participant[] = ['claude', 'codex'];
  let last: string | undefined;

  while (goal.turnsUsed < goal.maxTurns) {
    const self = order[goal.turnsUsed % order.length];

    let text: string;
    try {
      text = await takeTurn(goal, self, last, models, efforts);
    } catch (error) {
      goal.status = 'failed';
      emit(`${self} failed: ${(error as Error).message}`);
      saveGoal(goal);
      return goal;
    }

    goal.turnsUsed += 1;
    goal.transcript.push({ participant: self, turn: goal.turnsUsed, text });
    saveGoal(goal);
    emit(`--- ${self} (turn ${goal.turnsUsed}/${goal.maxTurns}) ---\n${text}\n`);

    // Only the responder can end it, so one side cannot declare victory alone.
    if (text.includes(DONE_MARKER) && last?.includes(DONE_MARKER)) {
      goal.status = 'complete';
      saveGoal(goal);
      emit(`goal ${goal.id} complete after ${goal.turnsUsed} turns`);
      return goal;
    }

    last = text;
  }

  goal.status = 'budget_limited';
  saveGoal(goal);
  emit(`goal ${goal.id} hit its turn budget (${goal.maxTurns})`);
  return goal;
}
