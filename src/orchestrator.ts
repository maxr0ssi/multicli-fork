import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadConfig } from './config.js';
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

const GOAL_ID_PATTERN = /^[0-9a-f]{12}$/;
const OBJECTIVE_REF_PATTERN = /^[0-9a-f]{24}$/;
const PRIVATE_OBJECTIVE_LABEL = '[private objective]';
const PRIVATE_REPLY_LABEL = '[reply not retained]';
const LEGACY_PRIVACY_VERSION = 2;

// The agents declare completion in their own words, so the signal has to be
// something they will not emit while merely discussing the work.
const DONE_MARKER = 'GOAL_COMPLETE';

export type GoalStatus = 'active' | 'complete' | 'budget_limited' | 'failed';
export type Participant = 'codex' | 'claude';
export type RunMode = 'debate' | 'solve';

/**
 * The old `orchestrate` command remains available for compatibility, but it
 * deliberately retains only metadata. New work should use the durable Studio
 * workflow path, where redaction and approvals are centralized.
 */
export const LEGACY_ORCHESTRATE_NOTICE =
  'Legacy compatibility command: use `multicli studio` (or Start-Luna-Build-Council) for new durable workflows.';

export interface GoalTranscriptEntry {
  participant: Participant;
  turn: number;
  /** Compatibility placeholder; it is never a model response. */
  text: string;
  /** Whether this live response declared the completion marker; never the response text. */
  completionDeclared?: boolean;
  recordedAt?: number;
}

export interface GoalRecord {
  id: string;
  /** A fixed privacy-safe label, retained for compatibility with `show`/`list`. */
  objective: string;
  /** Opaque correlation token; unlike an objective hash, it is not derived from user text. */
  objectiveRef?: string;
  mode: RunMode;
  status: GoalStatus;
  maxTurns: number;
  turnsUsed: number;
  scratchpad: string;
  conversations: Partial<Record<Participant, string>>;
  transcript: GoalTranscriptEntry[];
  createdAt: number;
  updatedAt: number;
  privacyVersion?: typeof LEGACY_PRIVACY_VERSION;
}

interface ActiveGoal {
  readonly record: GoalRecord;
  /** Exists only while this process is running and is never serialized. */
  readonly objectiveText: string;
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

/** Testable/private override follows the existing MULTICLI_RUNS_DIR convention. */
function goalDirectory(): string {
  return path.resolve(
    process.env.MULTICLI_GOALS_DIR ?? path.join(os.homedir(), '.multicli', 'goals'),
  );
}

function goalPath(id: string): string {
  if (!GOAL_ID_PATTERN.test(id)) {
    throw new Error(`Invalid goal id: ${JSON.stringify(id)}`);
  }

  const directory = goalDirectory();
  const filePath = path.join(directory, `${id}.json`);
  if (path.dirname(path.resolve(filePath)) !== directory) {
    throw new Error(`Refusing to escape goal directory: ${id}`);
  }

  return filePath;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function asParticipant(value: unknown): Participant | undefined {
  return value === 'codex' || value === 'claude' ? value : undefined;
}

function asMode(value: unknown): RunMode {
  return value === 'solve' ? 'solve' : 'debate';
}

function asStatus(value: unknown): GoalStatus {
  return value === 'active' || value === 'complete' || value === 'budget_limited' || value === 'failed'
    ? value
    : 'failed';
}

function opaqueObjectiveRef(value: unknown, id: string): string {
  return typeof value === 'string' && OBJECTIVE_REF_PATTERN.test(value)
    ? value
    : `legacy-${id}`;
}

function safeConversations(value: unknown): Partial<Record<Participant, string>> {
  const candidate = asRecord(value);
  const conversations: Partial<Record<Participant, string>> = {};
  for (const participant of ['codex', 'claude'] as const) {
    const handle = candidate?.[participant];
    if (typeof handle === 'string' && /^[0-9a-f]{16}$/.test(handle)) {
      conversations[participant] = handle;
    }
  }
  return conversations;
}

function safeTranscript(value: unknown): GoalTranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: GoalTranscriptEntry[] = [];
  for (const candidate of value) {
    const entry = asRecord(candidate);
    const participant = asParticipant(entry?.participant);
    const turn = entry?.turn;
    if (participant === undefined || typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) {
      continue;
    }
    const legacyText = typeof entry?.text === 'string' ? entry.text : '';
    entries.push({
      participant,
      turn,
      text: PRIVATE_REPLY_LABEL,
      completionDeclared: entry?.completionDeclared === true || legacyText.includes(DONE_MARKER),
      recordedAt: asTimestamp(entry?.recordedAt, 0),
    });
  }
  return entries;
}

function privacySafeGoal(value: unknown, id: string, now = Date.now()): GoalRecord | null {
  const source = asRecord(value);
  if (source === undefined || source.id !== id) return null;

  const scratchpad = source.scratchpad;
  if (typeof scratchpad !== 'string' || !path.isAbsolute(scratchpad)) return null;

  const maxTurns = source.maxTurns;
  const turnsUsed = source.turnsUsed;
  if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns < 0
    || typeof turnsUsed !== 'number' || !Number.isInteger(turnsUsed) || turnsUsed < 0) {
    return null;
  }

  return {
    id,
    objective: PRIVATE_OBJECTIVE_LABEL,
    objectiveRef: opaqueObjectiveRef(source.objectiveRef, id),
    mode: asMode(source.mode),
    status: asStatus(source.status),
    maxTurns,
    turnsUsed,
    scratchpad,
    conversations: safeConversations(source.conversations),
    transcript: safeTranscript(source.transcript),
    createdAt: asTimestamp(source.createdAt, now),
    updatedAt: asTimestamp(source.updatedAt, now),
    privacyVersion: LEGACY_PRIVACY_VERSION,
  };
}

function writeGoalRecord(goal: GoalRecord): void {
  const directory = goalDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = goalPath(goal.id);
  fs.writeFileSync(filePath, JSON.stringify(goal, null, 2), { mode: 0o600 });
  // `mode` only applies on creation; an old record could otherwise remain
  // group/world-readable after migration.
  fs.chmodSync(filePath, 0o600);
}

/** Removes only an unchanged legacy-generated objective file during migration. */
function removeLegacyObjectiveFile(scratchpad: string, legacyObjective: string | undefined): void {
  if (legacyObjective === undefined) return;
  const root = path.resolve(scratchpad);
  const candidate = path.resolve(root, 'OBJECTIVE.md');
  if (path.dirname(candidate) !== root) return;

  try {
    const expected = `# Objective\n\n${legacyObjective}\n`;
    if (fs.readFileSync(candidate, 'utf8') === expected) {
      fs.rmSync(candidate, { force: true });
    }
  } catch {
    // Missing, modified, or inaccessible scratchpad files are never removed.
  }
}

export function readGoal(id: string): GoalRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(goalPath(id), 'utf-8')) as unknown;
    const record = privacySafeGoal(raw, id);
    if (record === null) return null;

    const source = asRecord(raw);
    const legacyObjective = typeof source?.objective === 'string'
      && source.objective !== PRIVATE_OBJECTIVE_LABEL
      ? source.objective
      : undefined;
    const rawTranscriptHasText = Array.isArray(source?.transcript)
      && source.transcript.some((entry) => {
        const text = asRecord(entry)?.text;
        return typeof text === 'string' && text !== PRIVATE_REPLY_LABEL;
      });
    const needsMigration = legacyObjective !== undefined
      || rawTranscriptHasText
      || source?.privacyVersion !== LEGACY_PRIVACY_VERSION;

    if (needsMigration) {
      try {
        writeGoalRecord(record);
        removeLegacyObjectiveFile(record.scratchpad, legacyObjective);
      } catch {
        // Returning a safe in-memory view is still better than exposing raw
        // legacy content when the caller cannot rewrite the record.
      }
    }
    return record;
  } catch {
    return null;
  }
}

export function saveGoal(goal: GoalRecord): void {
  const safe = privacySafeGoal(goal, goal.id);
  if (safe === null) throw new Error(`Refusing to save invalid goal: ${JSON.stringify(goal.id)}`);
  safe.updatedAt = Date.now();
  Object.assign(goal, safe);
  writeGoalRecord(safe);
}

export function listGoals(): GoalRecord[] {
  try {
    return fs
      .readdirSync(goalDirectory())
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
    path.join(os.homedir(), '.multicli', 'runs')
  );
}

function createGoal(options: RunOptions): ActiveGoal {
  const id = randomBytes(6).toString('hex');
  const scratchpad = path.resolve(runsRoot(options.scratchpadRoot), id);
  fs.mkdirSync(scratchpad, { recursive: true, mode: 0o700 });

  const now = Date.now();
  const goal: GoalRecord = {
    id,
    objective: PRIVATE_OBJECTIVE_LABEL,
    objectiveRef: randomBytes(12).toString('hex'),
    mode: options.mode ?? 'debate',
    status: 'active',
    maxTurns: options.maxTurns ?? 6,
    turnsUsed: 0,
    scratchpad,
    conversations: {},
    transcript: [],
    createdAt: now,
    updatedAt: now,
    privacyVersion: LEGACY_PRIVACY_VERSION,
  };

  saveGoal(goal);
  return { record: goal, objectiveText: options.objective };
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

function buildPrompt(goal: ActiveGoal, self: Participant, lastFrom: string | undefined): string {
  const record = goal.record;
  const other = self === 'codex' ? 'Claude' : 'Codex';
  const role =
    record.mode === 'debate'
      ? `You are debating ${other}. Argue your position, concede points that are correct, and push back on ones that are not.`
      : `You are working with ${other} to complete the objective. Build on their work rather than repeating it.`;

  const first = record.turnsUsed === 0;

  return [
    `# Objective\n${goal.objectiveText}`,
    `# Your role\n${role}`,
    `# Shared scratchpad\nThe directory ${record.scratchpad} is shared with ${other} and is the ONLY place you may write.`,
    `Files currently there: ${scratchpadListing(record)}.`,
    'Read what is there before answering. Do not copy prompts or full replies into the scratchpad; store only concise, redacted task artifacts.',
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
  goal: ActiveGoal,
  self: Participant,
  lastFrom: string | undefined,
  models: Record<Participant, string>,
  efforts: Partial<Record<Participant, string>>,
): Promise<string> {
  const record = goal.record;
  const model = models[self];
  const handle = record.conversations[self];
  const conversationId = handle ?? 'new';
  const prompt = buildPrompt(goal, self, lastFrom);

  // cwd is the scratchpad, and write access is granted only there: the agents
  // can exchange artifacts without either of them reaching the wider filesystem.
  const context = { cwd: record.scratchpad, timeoutMs: loadConfig().askTimeoutMs };

  const text = await runConversationalTurn({
    cli: self,
    conversationId,
    model,
    sandbox: self === 'codex' ? 'workspace-write' : 'n/a',
    cwd: record.scratchpad,
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
    if (minted) record.conversations[self] = minted;
  }

  return text.replace(/\n\n---\nConversation handle:.*$/s, '').trim();
}

export async function runGoal(options: RunOptions): Promise<GoalRecord> {
  const activeGoal = createGoal(options);
  const goal = activeGoal.record;
  const models = { ...DEFAULT_MODELS, ...options.models };
  const efforts = options.efforts ?? {};
  const emit = options.onEvent ?? (() => {});

  emit(LEGACY_ORCHESTRATE_NOTICE);
  emit(`goal ${goal.id} started (objective retained only in this live process)`);
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
      text = await takeTurn(activeGoal, self, last, models, efforts);
    } catch (error) {
      goal.status = 'failed';
      emit(`${self} failed: ${(error as Error).message}`);
      saveGoal(goal);
      return goal;
    }

    goal.turnsUsed += 1;
    goal.transcript.push({
      participant: self,
      turn: goal.turnsUsed,
      text: PRIVATE_REPLY_LABEL,
      completionDeclared: text.includes(DONE_MARKER),
      recordedAt: Date.now(),
    });
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
