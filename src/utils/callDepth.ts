/**
 * Bounds recursive delegation between the backend CLIs.
 *
 * Both CLIs load this MCP server, and each hides only its own tools, so Claude
 * can ask Codex, the spawned Codex can ask Claude, and so on without limit.
 * Every hop is a paid call on an alternating subscription, so the chain has to
 * carry its own depth.
 *
 * The counter travels in the environment of the spawned CLI, which passes it to
 * the nested MCP server it starts. Nothing else links a parent call to a child.
 */

const DEPTH_VAR = 'MULTICLI_DEPTH';
const MAX_DEPTH_VAR = 'MULTICLI_MAX_DEPTH';

const DEFAULT_MAX_DEPTH = 3;

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Hops already taken to reach this server. 0 in the user's own session. */
export function getCallDepth(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env[DEPTH_VAR], 0);
}

export function getMaxCallDepth(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env[MAX_DEPTH_VAR], DEFAULT_MAX_DEPTH);
}

/**
 * Throw before spawning if this call would exceed the ceiling. Failing loudly
 * here is the point: a silent cap would look like a model refusing to help.
 */
export function assertCallDepthAvailable(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const depth = getCallDepth(env);
  const max = getMaxCallDepth(env);

  if (depth >= max) {
    throw new Error(
      `Delegation depth limit reached (${depth}/${max}) while trying to call ${target}. ` +
        'A chain of agents is already this many hops deep, and each hop spends a paid request. ' +
        `Answer directly instead, or raise ${MAX_DEPTH_VAR} if deeper delegation is genuinely wanted.`,
    );
  }
}

/** Environment for the spawned CLI, carrying the incremented depth. */
export function childEnv(
  base: NodeJS.ProcessEnv | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...(base ?? env),
    [DEPTH_VAR]: String(getCallDepth(env) + 1),
    [MAX_DEPTH_VAR]: String(getMaxCallDepth(env)),
  };
}
