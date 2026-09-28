# Workflow API

Experimental local orchestration through installed Claude and Codex CLIs.
Imports are side-effect free; provider authentication stays with the CLIs.

Build with `npm ci && npm run build`. Imports below resolve inside this checkout.
From another project, use `npm install /absolute/path/to/multicli-fork`; this
package is not published to npm.

## Run a built-in workflow

```ts
import {
  createHarmonyDeliveryWorkflow,
  createLocalOrchestrator,
  describeWorkflowApi,
} from '@maxr0ssi/multicli';

console.log(describeWorkflowApi()); // Profiles, primitives, caps, and routing
const local = createLocalOrchestrator({ workspace: process.cwd() });
try {
  const workflow = createHarmonyDeliveryWorkflow({
    lunaBuilders: 2,
    opusReviewers: 2,
  });
  const snapshot = await local.run(workflow, { objective: 'Implement and test the change' });
  console.log(snapshot.run.status, snapshot.approvals, snapshot.artifacts);
} finally {
  await local.close();
}
```

Approval gates return a waiting run. Inspect the pending approval and resolve
its exact `approvalId` and `actionHash` through `local.approve(...)` or Studio.
Do not approve automatically just because the example reached a gate.

## Custom graphs and drafts

Compose `defineWorkflow` with `sequence`, `agent`, `parallel`, `review`, and
`approval`. Use `profiles` for model, effort, and workspace-access settings.
Inspect `describeWorkflowApi()` for the current choices rather than assuming
all installed models support all roles.

The current routing uses Sol for direction, Luna/MAX for builders, and explicit
Opus/Sonnet alternatives. Terra is explicit-only; Fable is disabled. Per-graph
caps are Luna 20, Opus 5, Sol 3, and 5 for other models. The runner defaults to
five concurrent provider nodes and serializes workspace writers across runs.
`enableSubagents` defaults to false. Give profile variants distinct ids.

`Describe-Workflow-Design` and `Create-Workflow-Draft` expose draft authoring
through MCP. Creating a draft saves the proposal without executing providers.
Its receipt opens the exact workspace and ledger in [Studio](STUDIO.md).
Validate and publish there; publishing alone does not start a run.

## Persistent goals and storage

`local.openGoal({ goal, profile, workflowRevisionId })` opens a persistent
provider conversation bound to a workflow. Use `goal.turn(instruction)` for
follow-ups, `local.getGoal(id)` after a restart, and `goal.close()` when done.
A goal can bind to a `runId` instead. Provider, model, effort, access, directory,
and native session stay pinned. Uncertain provider advancement blocks resume
rather than silently replaying a turn.

The default ledger is `<workspace>/.multicli/runs.sqlite`; set `storePath` to
share it with Studio. Goal bodies are private artifacts, and events contain
metadata. Provider-reported usage remains unknown when the CLI omits it.
Leases renew while a process is quiet. There is no default workflow timeout;
set `maxRuntimeMs` only for an intentional ceiling. Cancellation stops active work.

Exports: `@maxr0ssi/multicli` plus `/workflows`, `/harness`, `/control-plane`,
and `/persistence`. See [AGENTS.md](../AGENTS.md) for repository checks.
