# Multi-CLI: handoff

Context for an agent picking up this system. It is self contained: you do not
need the conversation that produced it.

## What this is

A private fork of [osanoai/multicli](https://github.com/osanoai/multicli), an
MCP server that lets the Claude Code CLI and the OpenAI Codex CLI call each
other as tools. Both sides authenticate with the user's existing subscriptions.
No API key is used anywhere, and none should be introduced.

The fork adds persistent conversations, a delegation depth ceiling, and an
orchestrator, and fixes several security problems in the upstream code. The
complete list of differences from upstream is in `FORK.md`.

## Where things live

| Path | Contents |
| --- | --- |
| `~/Documents/Columbia/multicli` | the tool: source, tests, build output |
| `~/Documents/Columbia/multicli-runs/<goalId>/` | orchestrator scratchpads |
| `~/.multicli/conversations/<handle>.json` | conversation to session mapping |
| `~/.multicli/goals/<goalId>.json` | goal records, replayable |
| `~/.codex/sessions/`, `~/.claude/projects/` | the CLIs' own transcripts |

Git remotes: `origin` is the private fork, `upstream` is `osanoai/multicli`.
Upstream history is preserved, so `git log` separates the two.

No prompt or reply text is stored by this tool. `~/.multicli` holds mappings and
metadata only. The conversation content itself lives in each CLI's own store,
under that CLI's own retention.

## The tools

Six MCP tools, filtered per client so neither CLI sees its own:

| From Claude Code | From Codex |
| --- | --- |
| `Ask-Codex` | `Ask-Claude` |
| `Codex-Help` | `Claude-Help` |
| `List-Codex-Models` | `List-Claude-Models` |

`Ask-Codex` takes `prompt`, `model`, `sandbox`, `conversationId`.
`Ask-Claude` takes `prompt`, `model`, `permissionMode`, `maxBudgetUsd`,
`systemPrompt`, `conversationId`.

The agent on the other end is a full agent, not a text completion. Codex has
`exec`, `apply_patch`, `web__run` and its own agent spawning tools. Claude has
its usual file and shell tools under its permission system. This is why the
sandbox default below matters.

## Persistent conversations

`conversationId` controls memory:

- omitted: a one shot call with no memory of earlier calls
- `"new"`: opens a conversation; the reply ends with a 16 character handle
- `<handle>`: continues that conversation

This resumes each CLI's **native** session, so the model recalls its own earlier
reasoning. It is not a replayed transcript.

A conversation is pinned to the model, sandbox and working directory it was
opened with, and a lock file serialises its turns. Handles expire after 30 days.

## Orchestrator

```
orchestrate run "<objective>" [--mode debate|solve] [--turns N]
                              [--claude MODEL] [--codex MODEL]
                              [--codex-effort low|medium|high|xhigh|max|ultra]
                              [--scratchpad DIR]
orchestrate list
orchestrate show <goalId>
```

Two agents work one objective until both agree it is met or the turn budget is
spent. Each keeps its own persistent conversation. They share a scratchpad
directory which is also their working directory and the only place either may
write, so they exchange artifacts without reaching the wider filesystem.

Completion needs `GOAL_COMPLETE` on two consecutive turns, so one side cannot
declare victory alone. Goals persist and replay with `orchestrate show`.

Codex models available here: `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`.
`--claude-effort` is accepted but inert, because Claude Code sets its own effort.

## Invariants you must not break

These are load bearing. Tests assert each one. If a test in this list fails,
the fix is the code, not the test.

1. **Codex defaults to a read only sandbox.** `--full-auto` may be sent only
   when the caller explicitly asks for `workspace-write` or
   `danger-full-access`. Adding `-s read-only` is not a substitute: `--full-auto`
   overrides a later `-s`, verified against codex 0.145.0. The flag has to be
   absent.

2. **Every identifier is validated before it reaches a path.** Conversation
   handles match `^[0-9a-f]{16}$`, chunk cache keys `^[0-9a-f]{8}$`, native
   session ids a UUID regex. An unvalidated id was previously an arbitrary file
   deletion primitive, confirmed by deleting a real file.

3. **Never resume Codex with a non UUID session id.** `codex exec resume` treats
   a non UUID argument as a thread name and, on a miss, silently starts a brand
   new paid session and answers as if nothing happened, losing all history with
   no error.

4. **No prompt or reply text at debug log level.** Both MCP registrations set
   `MULTICLI_LOG_LEVEL=error`. Keep it if you re register them.

5. **No new npm dependency.** Node builtins plus the three existing runtime deps
   only. The tree is pruned to production, so a dev only import will break the
   installed tool.

6. **A conversation handle is not an escalation path.** A resumed turn may not
   widen its sandbox, change model, or run outside the directory it was opened
   in.

## Traps found the hard way

Each of these cost real debugging. They are not obvious from the help text.

- The Codex session id is printed on **stderr**, not stdout. The model reply is
  on stdout. Grepping stdout for the id finds nothing.
- `codex exec resume` has a different flag set from `codex exec`. It rejects
  `-s`, `-C`, `--color` and `--full-auto`. The sandbox travels as
  `-c sandbox_mode=<mode>`, which was verified to be enforced and not merely
  parsed.
- `codex exec` rejects `-a`/`--approval` as of 0.145.0. Forwarding it fails the
  whole call.
- `--ephemeral` writes no rollout, so an ephemeral turn silently makes a
  conversation unresumable.
- Codex does no locking on concurrent resume. Two resumes of one session both
  append to the same rollout and one turn is lost.
- Claude derives its project directory by replacing **every** non alphanumeric
  character, not just `/`, and truncating long paths with a hash suffix. Any
  code that guesses that path will be wrong.
- Passing `<` `/dev/null` matters for automated Codex calls. Without it Codex
  waits on stdin and appears to hang.

## Build, test, install

```sh
npm install                                  # dev deps, needed to build or test
npm run build
npm test                                     # 340 tests
npm link                                     # puts multicli and orchestrate on PATH
npm install --omit=dev --ignore-scripts      # back to the 91 package runtime tree
```

The installed tool runs from `dist/`, which is gitignored, so a fresh clone must
build before linking. `npm link` symlinks rather than copies, so editing source
and rebuilding takes effect immediately in both CLIs.

Register with both CLIs by absolute path, never via `npx`, which would download
a fresh version on every launch and discard the audit:

```sh
claude mcp add -s user multicli -e MULTICLI_LOG_LEVEL=error -- node "$PWD/dist/index.js"
codex  mcp add    multicli --env MULTICLI_LOG_LEVEL=error -- node "$PWD/dist/index.js"
```

## Limits

**Claude can call Codex. Codex cannot call Claude by default.** `codex exec`
auto cancels every MCP tool call because there is no human to approve one. It
works only with `approvals_reviewer = "auto_review"` in `~/.codex/config.toml`,
which was verified end to end. That setting removes the human from the approval
loop and makes agent to agent chains genuinely recursive, so the depth ceiling
(`MULTICLI_MAX_DEPTH`, default 3) and turn budget (`MULTICLI_MAX_TURNS`, default
50) become the only bounds. The user should decide whether to enable it.

Debate mode runs with write access scoped to the scratchpad directory. That is a
deliberate relaxation of invariant 1, confined to that directory.

Gemini, Antigravity and OpenCode are supported upstream but not installed here,
so those tools stay hidden.
