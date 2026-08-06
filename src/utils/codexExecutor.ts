import { executeCommand } from './commandExecutor.js';
import { CLI } from '../constants.js';
import { ToolExecutionContext } from '../execution.js';
import { isValidNativeSessionId } from './conversationStore.js';
import { assertCallDepthAvailable, childEnv } from './callDepth.js';

// Asking a question should not grant write access. The tool schema tells the
// model not to set `sandbox` unless it has a reason, so the unset case is the
// common one and must be the safe one.
const DEFAULT_SANDBOX = "read-only";

// `--full-auto` suppresses approval prompts AND forces a writable workspace: it
// beats a later `-s read-only` (verified against codex 0.145.0), so it can only
// be sent once the caller has explicitly asked for a write-capable sandbox.
const WRITE_SANDBOXES = new Set(["workspace-write", "danger-full-access"]);

// The startup banner goes to stderr, one line, no ANSI once --color never is set.
const SESSION_ID_PATTERN =
  /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

export interface CodexOptions {
  /** Reasoning effort: low | medium | high | xhigh | max | ultra. */
  effort?: string;
}

export interface CodexResult {
  text: string;
  /** Native session id: scraped on a new session, echoed back on a resume. */
  sessionId?: string;
}

export async function executeCodexCLI(
  prompt: string,
  model: string,
  sandbox?: string,
  approvalPolicy?: string,
  context?: ToolExecutionContext,
  resumeSessionId?: string,
  options: CodexOptions = {},
): Promise<CodexResult> {
  assertCallDepthAvailable('Codex');

  const effectiveSandbox = sandbox ?? DEFAULT_SANDBOX;

  // Both subcommands accept -c overrides, so this applies to new and resumed turns.
  const overrides: string[] = options.effort
    ? ['-c', `model_reasoning_effort=${options.effort}`]
    : [];

  // `codex exec resume` rejects -s/--sandbox, -C/--cd, --color and --full-auto:
  // reusing one arg list across both subcommands crashes on turn 2. The sandbox
  // travels as a config override instead, which is enforced, not just parsed.
  if (resumeSessionId !== undefined) {
    if (!isValidNativeSessionId(resumeSessionId)) {
      throw new Error(
        `Refusing to resume codex with a non-UUID session id: ${JSON.stringify(resumeSessionId)}. ` +
          'Codex would treat it as a thread name and silently start a new session.',
      );
    }

    const resumeArgs: string[] = [
      CLI.SUBCOMMANDS.EXEC, 'resume', resumeSessionId, prompt,
      CLI.CODEX_FLAGS.SKIP_GIT_CHECK,
      '-c', `sandbox_mode=${effectiveSandbox}`,
      ...overrides,
      CLI.CODEX_FLAGS.MODEL, model,
    ];

    const text = await executeCommand(CLI.COMMANDS.CODEX, resumeArgs, {
      ...context,
      env: childEnv(context?.env),
    });
    return { text, sessionId: resumeSessionId };
  }

  const args: string[] = [
    CLI.SUBCOMMANDS.EXEC, prompt,
    CLI.CODEX_FLAGS.SKIP_GIT_CHECK,
    CLI.CODEX_FLAGS.COLOR, "never",
    CLI.CODEX_FLAGS.MODEL, model,
    CLI.CODEX_FLAGS.SANDBOX, effectiveSandbox,
    ...overrides,
  ];

  if (WRITE_SANDBOXES.has(effectiveSandbox)) {
    args.push(CLI.CODEX_FLAGS.FULL_AUTO);
  }

  // `codex exec` (CLI 0.145.0+) errors out on -a/--approval. Forwarding it
  // fails the whole call, so approvalPolicy is deliberately dropped.
  void approvalPolicy;

  let sessionId: string | undefined;
  const text = await executeCommand(CLI.COMMANDS.CODEX, args, {
    ...context,
    env: childEnv(context?.env),
  }, (chunk) => {
    if (sessionId) return;
    const match = SESSION_ID_PATTERN.exec(chunk);
    if (match) sessionId = match[1];
  });

  return { text, sessionId };
}
