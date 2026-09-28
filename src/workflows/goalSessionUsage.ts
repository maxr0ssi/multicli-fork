import type { GoalSessionArtifactRecord } from '../persistence/runLedger.js';
import type { AttemptUsage } from './domain.js';

export const ATTEMPT_USAGE_FIELDS = [
  'estimatedCostUsd',
  'inputTokens',
  'cachedInputTokens',
  'cacheCreationInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
] as const satisfies readonly (keyof AttemptUsage)[];

export type AttemptUsageField = (typeof ATTEMPT_USAGE_FIELDS)[number];
export type GoalSessionTurnOutcome = 'succeeded' | 'failed' | 'blocked';

export interface GoalSessionTurnTelemetry {
  readonly version: 1;
  readonly scope: 'permanent-goal-session-turn';
  readonly outcome: GoalSessionTurnOutcome;
  readonly resumed: boolean;
  readonly usage?: AttemptUsage;
}

export interface GoalSessionTurnUsage {
  readonly artifactId: string;
  readonly turnNumber: number;
  readonly outcome: GoalSessionTurnOutcome;
  /** Missing for artifacts written before resume telemetry was introduced. */
  readonly resumed?: boolean;
  readonly recordedAt: string;
  readonly usage?: AttemptUsage;
}

export interface GoalSessionUsageProjection {
  readonly scope: 'permanent-goal-session';
  readonly providerCalls: number;
  readonly usageReports: number;
  /** Only fields reported by at least one provider call are present. */
  readonly totals: AttemptUsage;
  readonly fieldReports: Readonly<Record<AttemptUsageField, number>>;
  readonly turns: readonly GoalSessionTurnUsage[];
}

type TelemetryMetadata = {
  readonly private: true;
  readonly goalSessionTurn: GoalSessionTurnTelemetry;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Accept only provider-reportable values. Missing or malformed fields remain unknown. */
export function attemptUsageFromUnknown(value: unknown): AttemptUsage | undefined {
  const source = object(value);
  if (!source) return undefined;
  const usage: Partial<Record<AttemptUsageField, number>> = {};
  for (const field of ATTEMPT_USAGE_FIELDS) {
    const candidate = source[field];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      usage[field] = candidate;
    }
  }
  return Object.keys(usage).length ? usage : undefined;
}

export function goalSessionTurnMetadata(input: {
  outcome: GoalSessionTurnOutcome;
  resumed: boolean;
  usage?: AttemptUsage;
}): TelemetryMetadata {
  const usage = attemptUsageFromUnknown(input.usage);
  return {
    private: true,
    goalSessionTurn: {
      version: 1,
      scope: 'permanent-goal-session-turn',
      outcome: input.outcome,
      resumed: input.resumed,
      ...(usage ? { usage } : {}),
    },
  };
}

function telemetryFromArtifact(
  artifact: GoalSessionArtifactRecord,
): GoalSessionTurnTelemetry | undefined {
  const metadata = object(artifact.metadata);
  const telemetry = object(metadata?.goalSessionTurn);
  const outcome = telemetry?.outcome;
  if (
    telemetry?.version !== 1
    || telemetry.scope !== 'permanent-goal-session-turn'
    || (outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'blocked')
    || typeof telemetry.resumed !== 'boolean'
  ) return undefined;
  const usage = attemptUsageFromUnknown(telemetry.usage);
  return {
    version: 1,
    scope: 'permanent-goal-session-turn',
    outcome,
    resumed: telemetry.resumed,
    ...(usage ? { usage } : {}),
  };
}

/** Project immutable reply/usage artifacts into provider-call telemetry. */
export function projectGoalSessionUsage(
  artifacts: readonly GoalSessionArtifactRecord[],
): GoalSessionUsageProjection {
  const turns = artifacts.flatMap((artifact): GoalSessionTurnUsage[] => {
    if (artifact.turnNumber === undefined) return [];
    const telemetry = telemetryFromArtifact(artifact);
    if (telemetry) {
      return [{
        artifactId: artifact.id,
        turnNumber: artifact.turnNumber,
        outcome: telemetry.outcome,
        resumed: telemetry.resumed,
        recordedAt: artifact.createdAt,
        ...(telemetry.usage ? { usage: telemetry.usage } : {}),
      }];
    }
    // Historical replies predate typed telemetry but still prove one provider call.
    return artifact.kind === 'reply'
      ? [{
        artifactId: artifact.id,
        turnNumber: artifact.turnNumber,
        outcome: 'succeeded',
        recordedAt: artifact.createdAt,
      }]
      : [];
  }).sort((left, right) => (
    left.turnNumber - right.turnNumber
    || left.recordedAt.localeCompare(right.recordedAt)
  ));
  const fieldReports = Object.fromEntries(
    ATTEMPT_USAGE_FIELDS.map(field => [field, 0]),
  ) as Record<AttemptUsageField, number>;
  const totals: Partial<Record<AttemptUsageField, number>> = {};
  let usageReports = 0;
  for (const turn of turns) {
    if (turn.usage) usageReports += 1;
    for (const field of ATTEMPT_USAGE_FIELDS) {
      const value = turn.usage?.[field];
      if (value === undefined) continue;
      fieldReports[field] += 1;
      totals[field] = (totals[field] ?? 0) + value;
    }
  }
  return {
    scope: 'permanent-goal-session',
    providerCalls: turns.length,
    usageReports,
    totals,
    fieldReports,
    turns,
  };
}
