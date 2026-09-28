import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  GoalSessionArtifactRecord,
  GoalSessionRecord,
  RunLedger,
} from '../persistence/runLedger.js';
import { isValidNativeSessionId } from '../utils/conversationStore.js';
import type { AttemptUsage, ResolvedProfile, WorkflowProfile } from './domain.js';
import { goalSessionTurnMetadata } from './goalSessionUsage.js';

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty`);
  return trimmed;
}

export function normalizedGoalProfile(
  profile: ResolvedProfile | WorkflowProfile,
): ResolvedProfile {
  if ('profileId' in profile) return profile;
  return {
    profileId: profile.id,
    provider: profile.provider,
    model: profile.model,
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    workspaceAccess: profile.workspaceAccess,
    selection: profile.selection,
    enableSubagents: profile.enableSubagents ?? false,
  };
}

function sessionDirectory(artifactRoot: string, id: string): string {
  if (!isValidNativeSessionId(id)) throw new Error('Goal session id must be a UUID');
  return path.join(path.resolve(artifactRoot), 'goal-sessions', id);
}

function writePrivateFile(directory: string, filename: string, text: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const destination = path.join(directory, filename);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, text, { encoding: 'utf8' });
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, destination);
  } finally {
    fs.unlinkSync(temporary);
  }
  fs.chmodSync(destination, 0o600);
  return destination;
}

export function writeGoalFile(artifactRoot: string, id: string, goal: string) {
  return {
    contentHash: sha256Text(goal),
    location: writePrivateFile(sessionDirectory(artifactRoot, id), 'goal.md', goal),
  };
}

export function writeGoalTurnArtifact(input: {
  store: RunLedger;
  artifactRoot: string;
  session: GoalSessionRecord;
  turnNumber: number;
  kind: 'instruction' | 'reply';
  text: string;
  metadata?: unknown;
}): GoalSessionArtifactRecord {
  const location = writePrivateFile(
    sessionDirectory(input.artifactRoot, input.session.id),
    `turn-${input.turnNumber}-${input.kind}-${randomUUID()}.md`,
    input.text,
  );
  return input.store.recordGoalSessionArtifact({
    sessionId: input.session.id,
    turnNumber: input.turnNumber,
    kind: input.kind,
    contentHash: sha256Text(input.text),
    mediaType: 'text/markdown',
    name: `Goal session turn ${input.turnNumber} ${input.kind}`,
    location,
    metadata: input.metadata ?? { private: true },
  });
}

export function writeGoalTurnUsageArtifact(input: {
  store: RunLedger;
  artifactRoot: string;
  session: GoalSessionRecord;
  turnNumber: number;
  outcome: 'failed' | 'blocked';
  resumed: boolean;
  usage?: AttemptUsage;
}): GoalSessionArtifactRecord {
  const metadata = goalSessionTurnMetadata(input);
  const contents = `${JSON.stringify(metadata.goalSessionTurn, null, 2)}\n`;
  const location = writePrivateFile(
    sessionDirectory(input.artifactRoot, input.session.id),
    `turn-${input.turnNumber}-usage-${randomUUID()}.json`,
    contents,
  );
  return input.store.recordGoalSessionArtifact({
    sessionId: input.session.id,
    turnNumber: input.turnNumber,
    kind: 'usage',
    contentHash: sha256Text(contents),
    mediaType: 'application/vnd.multicli.goal-turn+json',
    name: `Goal session turn ${input.turnNumber} usage`,
    location,
    metadata,
  });
}

export function buildGoalSessionPrompt(input: {
  store: RunLedger;
  session: GoalSessionRecord;
  instruction: string;
}): string {
  const { store, session, instruction } = input;
  const sections: string[] = [];
  if (!session.nativeSessionId) {
    const goalArtifact = store.listGoalSessionArtifacts(session.id)
      .find(artifact => artifact.id === session.goalArtifactId);
    if (!goalArtifact) throw new Error(`Goal artifact is missing for session ${session.id}`);
    const goal = fs.readFileSync(goalArtifact.location, 'utf8');
    if (sha256Text(goal) !== goalArtifact.contentHash) {
      throw new Error(`Goal artifact integrity check failed for session ${session.id}`);
    }
    sections.push(
      'You are the permanent director for this goal. Preserve continuity across iterations and use the current workflow context to choose the next concrete action.',
      `Goal:\n${goal}`,
    );
  }
  if (session.runId) {
    const run = store.getRun(session.runId);
    if (!run) throw new Error(`Bound run ${session.runId} no longer exists`);
    const events = store.listEvents(run.id, Math.max(0, run.lastSequence - 100), 100);
    const artifacts = store.listArtifacts(run.id);
    sections.push([
      'Current workflow context (metadata only):',
      `runId=${run.id}`,
      `workflowRevisionId=${run.workflowRevisionId}`,
      `status=${run.status}`,
      `eventSequence=${run.lastSequence}`,
      `recentEvents=${events.map(event => `${event.sequence}:${event.type}`).join(', ') || 'none'}`,
      `artifacts=${artifacts.map(artifact => (
        `${artifact.id}:${artifact.name}:${artifact.contentHash}:${artifact.location}`
      )).join(', ') || 'none'}`,
    ].join('\n'));
  } else if (session.workflowRevisionId) {
    const linkedRuns = store.listRuns(1_000)
      .filter(run => run.workflowRevisionId === session.workflowRevisionId)
      .slice(0, 10);
    const runContext = linkedRuns.map(run => {
      const events = store.listEvents(run.id, Math.max(0, run.lastSequence - 20), 20);
      const artifacts = store.listArtifacts(run.id).slice(-20);
      return [
        `runId=${run.id}`,
        `status=${run.status}`,
        `eventSequence=${run.lastSequence}`,
        `recentEvents=${events.map(event => `${event.sequence}:${event.type}`).join(', ') || 'none'}`,
        `artifacts=${artifacts.map(artifact => (
          `${artifact.id}:${artifact.name}:${artifact.contentHash}:${artifact.location}`
        )).join(', ') || 'none'}`,
      ].join('\n');
    }).join('\n---\n');
    sections.push([
      'Current workflow context (metadata only):',
      `workflowRevisionId=${session.workflowRevisionId}`,
      runContext || 'runs=none',
    ].join('\n'));
  }
  sections.push(`Iteration instruction:\n${instruction}`);
  return sections.join('\n\n');
}
