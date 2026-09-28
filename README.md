# Multi-CLI

Inspired by [osanoai/multicli](https://github.com/osanoai/multicli).

An experimental MCP bridge that lets Claude Code and Codex call each other's CLI and keep conversations going. Anyone can try it; expect rough edges. Calls use your installed CLIs, their authentication, and provider quota.

## Setup

For an agent setting this up: build this checkout, register its absolute path in both clients, preserve existing configuration, and verify a read-only call. No npm release is available.

You need Node.js **24+**, npm, Git, and authenticated `claude` and `codex` commands on `PATH`. Run each CLI directly once to finish setup.

```bash
git clone https://github.com/maxr0ssi/multicli-fork.git
cd multicli-fork
npm ci
npm run build

MULTICLI_ENTRY="$PWD/dist/index.js"
MULTICLI_NODE="$(command -v node)"
```

Keep the checkout in this location. Rebuild after pulling updates.

### Claude → Codex

```bash
claude mcp add --scope user --transport stdio Multi-CLI -- "$MULTICLI_NODE" "$MULTICLI_ENTRY"
claude mcp get Multi-CLI
```

If that entry already exists, update it instead of adding a duplicate. Start a new Claude session in your target project with longer client timeouts:

```bash
cd /absolute/path/to/your-project
MCP_TIMEOUT=120000 MCP_TOOL_TIMEOUT=14400000 claude
```

This allows two minutes for startup and four hours per tool call. To persist it, merge those variables into `env` in `~/.claude/settings.json`. They belong to the calling Claude process, not the MCP server's `--env` settings.

### Codex → Claude

```bash
codex mcp add Multi-CLI -- "$MULTICLI_NODE" "$MULTICLI_ENTRY"
codex mcp get Multi-CLI
```

Add these lines to the existing `[mcp_servers.Multi-CLI]` table in `~/.codex/config.toml`:

```toml
startup_timeout_sec = 120
tool_timeout_sec = 14400
```

Do not duplicate the table. Start a new Codex session in your target project.

### Check it works

Ask Claude:

> List the Codex models through Multi-CLI, choose one, and ask Codex to report its working directory and describe this repository. Do not change files.

In Codex, ask the same of Claude. Check the returned directory before requesting edits. Tools use the first filesystem root advertised by the client, falling back to the server's launch directory.

## Using it

Use `List-Codex-Models` / `Ask-Codex` or `List-Claude-Models` / `Ask-Claude`. Ask tools require `model` and `prompt`; choose an ID from the model list and give the other agent paths it can inspect.

- **Persistent by default:** each call without a handle starts a new session. Reuse the returned `conversationId` for follow-ups; otherwise you start another session.
- **Explicit choices:** `conversationId: "new"` starts another session; `"none"` makes a one-shot call.
- **Pinned settings:** keep the same provider, model, working directory, and access mode. Only one turn can run on a handle at once.
- **Codex access:** defaults to `sandbox: "read-only"`; use `"workspace-write"` for authorized edits.
- **Claude access:** defaults explicitly to `permissionMode: "default"`; `"acceptEdits"` permits authorized file edits. Repeat the same mode on follow-ups. Headless calls cannot rely on interactive approvals.

These are provider CLI sessions, not messages into an unrelated open terminal or desktop chat. Default limits are 50 turns per conversation (`MULTICLI_MAX_TURNS`) and three recursive delegation hops (`MULTICLI_MAX_DEPTH`).

Direct Claude/Codex calls have **no server timeout by default**. The client settings above allow four hours; raise them if needed. An optional server environment variable, `MULTICLI_ASK_TIMEOUT_MS`, sets a ceiling (`0` or unset means unlimited). Quiet output alone does not mean a call has stopped.

## If it fails

- Check Node 24+, the compiled entrypoint, and both CLI commands in the server's launch environment.
- For authentication errors, run the affected CLI directly and sign in.
- For early timeouts, check the calling client's limits as well as the server setting.
- For a wrong directory, correct the client project root or server launch directory.
- If a native session disappeared, start a new conversation.

Diagnostic logs: `~/.multicli/logs/multicli.log`. Default logs exclude prompt/reply bodies. See [SECURITY.md](SECURITY.md) before granting write access.

## Other parts

The repo also has an experimental [Studio](docs/STUDIO.md) (`node dist/index.js studio`), a [workflow API](docs/AGENT_WORKFLOW_API.md), and Antigravity/OpenCode support. None is required for Claude ↔ Codex calls.

For development, run `npm run lint`, `npm run build`, and `npm test`. The full gate is `node dist/index.js harness run --trigger pre-push`. [Live MCP checks](tests/TESTS.md) are separate and use provider quota. See [NOTICE](NOTICE) for provenance.
