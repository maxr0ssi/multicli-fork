# Repository instructions

Multi-CLI connects installed coding-agent CLIs over MCP (stdio or authenticated
loopback HTTP). It also provides durable workflows, a SQLite ledger, and a
Preact Studio. Model execution and authentication belong to the provider CLIs;
do not add direct model API keys or assume how a CLI was authenticated.

## Working on changes

- For nontrivial changes, record the plan and verification steps in
  `tasks/todo.md`; update it with results. Re-plan when findings change the scope.
- Use focused subagents for independent investigation or implementation.
- Read `tasks/lessons.md` when present; record concrete lessons from user
  corrections there.
- Trace affected callers before changing shared behavior. Preserve unrelated
  local changes and fix causes rather than hiding errors.
- Add or update tests for changed source behavior, including regressions for
  bug fixes. Run `npm test` before marking work complete. Use
  `npm run test:coverage` when a change may reduce coverage.
- Report what changed, what was verified, and any unresolved failures.

## Commands

Use Node.js 24 or newer. This is an ESM TypeScript project.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install locked dependencies |
| `npm run build` | Compile TypeScript, bundle Studio, copy the model catalog |
| `npm run clean` | Remove generated `dist/` output |
| `npm run lint` | Type-check without emitting |
| `npm test` | Run `tests/**/*.test.ts` with Vitest |
| `npm run test:watch` | Watch tests |
| `npm run test:coverage` | Run V8 coverage |
| `npm start` | Run the compiled MCP server |
| `npm run dev` | Build and run MCP |
| `node dist/index.js studio` | Launch Studio on loopback |
| `node dist/index.js harness run --trigger pre-push` | Run the repository gate |
| `npm run try:claude -- --dry-run "objective"` | Inspect the Claude workflow without model execution |
| `npm run refresh-catalog` | Regenerate the model catalog |

CI runs the compiled harness on Node 24, including type-checking, build, tests,
and source-size checks. Authored TypeScript warns at 400 physical lines and
blocks at 600. Mock provider processes and external I/O in automated tests;
[the live MCP checklist](tests/TESTS.md) is separate.

## Source map

- `src/server/`, `src/tools/`: MCP transport and tools.
- `src/workflows/`: workflow domain, scheduling, and provider execution.
- `src/persistence/`: SQLite ledger.
- `src/controlPlane/`: commands, REST, and SSE.
- `src/studio/`: typed read model and UI.
- `src/harness/`: repository policy.
- `src/publicApi.ts`: package exports; importing must remain side-effect free.

## Distribution and instruction aliases

Install from source as described in [README.md](README.md). The package is
private to prevent accidental npm publication; the repository may be public.
Do not restore upstream publishing or version-bump automation without an
explicit distribution decision.

`CLAUDE.md`, `GEMINI.md`, and `CODEX.md` are symlinks to this file. Edit only
`AGENTS.md` when changing repository instructions.
