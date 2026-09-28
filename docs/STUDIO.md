# Studio

An experimental local UI for workflow drafts, runs, approvals, and goal
sessions. Model calls use your installed Claude and Codex CLIs.

## Launch

```bash
npm run build
node dist/index.js studio
```

Studio binds to loopback and opens a single-use launch URL. Use `--no-open` to
print it instead. The browser receives a session cookie, not the MCP bearer.

To view a specific object, use its receipt's workspace and store:

```bash
node dist/index.js studio --draft <id> --workspace <path> --store <sqlite-path>
node dist/index.js studio --run <id> --node <node-id> --workspace <path> --store <sqlite-path>
```

Explicit paths must exist. `--draft` and `--run` are mutually exclusive;
`--node` requires `--run`. Processes must use the same ledger to share runs.

## Use

Choose a run in the left rail. Open **Workflow** for its graph, select a node
for details, or inspect **Approvals**, **Outputs**, and **Activity**.

Drafts support adding/removing agents and editing prompts, dependencies, models,
effort, access, and subagents. In chat, `Describe-Workflow-Design` and
`Create-Workflow-Draft` create a proposal and return its Studio launch arguments.
Validate before **Publish revision**; **Publish and run** also starts providers.
Published revisions and historical runs remain unchanged.

**Pause** lets active work finish before stopping scheduling. **Cancel** stops
active work. Approvals bind to the displayed action hash; inspect the evidence
before deciding. **Steer** starts a persistent goal turn where supported, not
an interruption of an active one-shot call. Missing controls mean the action
is unavailable for that run or node.

## Data and rough edges

Default ledger: `~/.multicli/studio/runs.sqlite`; the package API defaults to
`<workspace>/.multicli/runs.sqlite`. Artifacts live beside the selected ledger.
Set `MULTICLI_RUN_STORE_PATH` or `--store` to select another ledger.

Quiet models can remain healthy through lease heartbeats. There is no default
workflow timeout. Usage is provider-reported and unknown where omitted.
Persistent goal bodies are private local artifacts; CLIs keep their own
transcripts. Previews reject symlinks, changed, oversized, or non-text artifacts.

For missing runs, check the exact store path. For model errors, try the CLI
directly and confirm sign-in. For an expired launch link, launch Studio again.
See the [workflow API](AGENT_WORKFLOW_API.md) and [security notes](../SECURITY.md).
