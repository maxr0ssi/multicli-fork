# Fork notes

A private fork of [osanoai/multicli](https://github.com/osanoai/multicli), an
MCP server that lets one coding CLI call another. Upstream history is preserved,
so `git log` separates their commits from the ones below.

This file is the complete list of how this copy differs from upstream, and why.
Read it before merging upstream changes: several of the changes below are load
bearing and a naive merge will quietly undo them.

## Why a fork rather than the published package

The upstream README installs it with `npx -y @osanoai/multicli@latest`, which
re-downloads from the npm registry on every launch and silently adopts whatever
version was published most recently. This copy is cloned, audited, built and run
from disk, so the code that was reviewed is the code that runs. The MCP
registrations point at `dist/index.js` by absolute path, never at `npx`.

Dependencies are installed with `--ignore-scripts`, and the runtime tree can be
pruned to production only (`npm install --omit=dev --ignore-scripts`), which
drops roughly 50 build-only packages. The build toolchain is only needed to run
`npm run build` and `npm test`.

## Security fixes

### Arbitrary file deletion via the chunk cache

`chunkCache.getChunks()` took an unvalidated cache key, joined it into a path,
and unlinked the file on any JSON parse failure. A key of
`../../../../path/to/file` deleted a file outside the cache directory. This was
confirmed by deleting a real file in a scratch directory, not inferred.

Fixed with a strict `^[0-9a-f]{8}$` allowlist checked before the key reaches the
filesystem. The same idiom guards every id introduced by this fork.

Reachability: the affected tool is only registered when the Antigravity CLI is
installed, so it was not exposed here, but installing that CLI would have armed
it.

### Codex could write files unprompted

`--full-auto` was passed on every call, which suppresses approval prompts and
forces a writable workspace, while the tool description told the model not to
set `sandbox` unless it had a reason. The common path therefore granted write
access to a tool whose purpose is answering questions.

The sandbox now defaults to `read-only`, and `--full-auto` is sent only when the
caller explicitly asks for `workspace-write` or `danger-full-access`.

Note for future edits: adding `-s read-only` is **not** sufficient.
`--full-auto` overrides a later `-s`, verified against codex 0.145.0. The flag
has to be absent.

### Prompts and replies written to a world readable log

The default log level is `debug`, and both the prompt (`serverApp.ts`) and the
backend CLI's stdout chunks (`commandExecutor.ts`) are logged, so
`~/.multicli/logs/multicli.log` accumulated a plaintext archive of prompts and
model output at mode 0644.

Not fixed in code, because upstream's default is deliberate. Fixed in operation:
both MCP registrations set `MULTICLI_LOG_LEVEL=error`, and `~/.multicli` is mode
0700. If you re-register the server, keep that environment variable.

## Compatibility fixes

`codex exec` rejects `-a`/`--approval` as of CLI 0.145.0; forwarding it failed
the whole call, so `approvalPolicy` is accepted and dropped.

`codex exec resume` has a different flag set from `codex exec`: it rejects `-s`,
`-C`, `--color` and `--full-auto`. The sandbox travels as
`-c sandbox_mode=<mode>` instead, which was verified to be enforced rather than
merely parsed.

## Features added

### Persistent conversations

`Ask-Codex` and `Ask-Claude` take an optional `conversationId`. Omit it for a
stateless one-shot, pass `"new"` to open a conversation, then pass back the
returned 16 character handle to continue it. Each side keeps its **native**
session, so the model remembers its own earlier reasoning rather than having a
transcript replayed at it.

The two CLIs differ, and the difference matters:

- Claude accepts `--session-id <uuid>`, so the id is minted up front and
  resumed with `--resume`.
- Codex has no such flag. The id is scraped from the `session id: <uuid>` line,
  which goes to **stderr**, not stdout.

Codex's resume has a trap worth knowing about: a session id that is not a valid
UUID is treated as a *thread name*, and on a miss it silently starts a brand new
paid session and answers as if nothing happened, losing all history without an
error. Every resume is therefore gated on a UUID regex.

Stored in `~/.multicli/conversations/<handle>.json`, mode 0600, 30 day TTL. The
mapping only: no prompt or reply text is stored. Delete a conversation by
deleting that file. The CLIs keep their own transcripts under their own
retention (`~/.codex/sessions/`, `~/.claude/projects/`).

A conversation is pinned to the model, sandbox and working directory it was
opened with, and a turn lock serialises turns. Codex applies no locking of its
own: two concurrent resumes of one session both append to the same rollout and
one turn is lost.

### Delegation depth ceiling

Both CLIs load this server, and each hides only its own tools, so Claude can ask
Codex and the spawned Codex can ask Claude, without limit. Every hop is a paid
call on an alternating subscription.

`MULTICLI_DEPTH` is incremented into the spawned CLI's environment and checked
before each spawn, with the ceiling in `MULTICLI_MAX_DEPTH` (default 3). A
conversation additionally has a turn budget, `MULTICLI_MAX_TURNS` (default 50).

Whether this is reachable depends on one Codex setting. With
`approvals_reviewer = "user"` (the default) `codex exec` auto-cancels every MCP
tool call, because there is no human to approve one, so Codex is effectively a
leaf. Setting it to `auto_review` makes Codex able to call back into Claude, at
which point the ceiling is the only thing bounding a chain.

### Orchestrator

`orchestrate` runs two agents against one objective until both agree it is met
or the turn budget is spent. It is a terminal entry point rather than an MCP
tool, because each turn spends a paid request and a person should start it.

```
orchestrate run "<objective>" [--mode debate|solve] [--turns N]
                              [--claude MODEL] [--codex MODEL]
                              [--codex-effort low|medium|high|xhigh|max|ultra]
                              [--scratchpad DIR]
orchestrate list
orchestrate show <goalId>
```

Each participant gets its own persistent conversation. They share a scratchpad
directory, which is also their working directory and the only place either of
them may write, so they exchange artifacts without reaching the wider
filesystem. Debate mode therefore runs with write access scoped to that
directory, which is a deliberate relaxation of the read-only default.

Completion requires two consecutive turns carrying `GOAL_COMPLETE`, so one side
cannot declare victory alone. Goals persist to `~/.multicli/goals/` and are
replayable with `orchestrate show`.

Runs are written to `$MULTICLI_RUNS_DIR`, defaulting to
`~/Documents/Columbia/multicli-runs`. That default is a personal preference, not
a general one; set the environment variable to move it. It is deliberately a
fixed location rather than relative to the current directory, which scattered
artifacts into whichever repository happened to be current.

## Install

```sh
npm install                 # or --omit=dev --ignore-scripts to run only
npm run build
npm link                    # puts `multicli` and `orchestrate` on PATH
```

Register with both CLIs, by absolute path, keeping the log level:

```sh
claude mcp add -s user multicli -e MULTICLI_LOG_LEVEL=error -- node "$PWD/dist/index.js"
codex  mcp add    multicli --env MULTICLI_LOG_LEVEL=error -- node "$PWD/dist/index.js"
```

`npm link` symlinks rather than copies, so editing source and rebuilding takes
effect in both CLIs with no reinstall.

## Tests

`npm test`. The suite covers the id validation, the read-only default, the
resume argv (including assertions that `--full-auto`, `--ephemeral` and
`--dangerously-bypass-approvals-and-sandbox` never appear on a resumed turn),
and the depth ceiling. Those assertions exist to fail loudly if a merge
reintroduces a fixed issue.
