#!/usr/bin/env node
import {
  LEGACY_ORCHESTRATE_NOTICE,
  listGoals,
  readGoal,
  runGoal,
  type RunMode,
} from './orchestrator.js';

/**
 * Drives a goal from the terminal. This is a user-facing entry point, not an
 * MCP tool: the loop spends a paid request per turn, so a person starts it.
 */

function usage(): void {
  console.log(`${LEGACY_ORCHESTRATE_NOTICE}

Usage:
  orchestrate run "<objective>" [options]
  orchestrate list
  orchestrate show <goalId>

Options:
  --mode debate|solve      debate argues a question, solve builds on shared work
  --turns N                turn budget for the run (default 6)
  --claude MODEL           e.g. opus or sonnet
  --codex MODEL            e.g. gpt-5.6-luna, gpt-5.6-sol, gpt-5.6-terra
  --codex-effort LEVEL     low | medium | high | xhigh | max | ultra
  --claude-effort LEVEL    recorded for parity; Claude Code sets effort itself
  --scratchpad DIR         where runs are written (default $MULTICLI_RUNS_DIR,
                           else ~/.multicli/runs)

This command keeps only privacy-safe metadata: objectives and model replies are
available only during the live process and are not replayable with \`show\`.
For durable local runs, approvals, and Studio, use \`multicli studio\`.`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'list') {
    const goals = listGoals();
    if (!goals.length) {
      console.log('No goals yet.');
      return;
    }
    for (const g of goals) {
      console.log(
        `${g.id}  ${g.status.padEnd(15)} ${String(g.turnsUsed).padStart(2)}/${g.maxTurns} turns  ${g.objective} (${(g.objectiveRef ?? 'legacy').slice(0, 8)})`,
      );
    }
    console.log(`\n${LEGACY_ORCHESTRATE_NOTICE}`);
    return;
  }

  if (command === 'show') {
    const goal = args[0] ? readGoal(args[0]) : null;
    if (!goal) {
      console.error(`No such goal: ${args[0] ?? '(missing id)'}`);
      process.exitCode = 1;
      return;
    }
    console.log(`# ${goal.objective} (${goal.objectiveRef ?? 'legacy'})\nstatus: ${goal.status}  turns: ${goal.turnsUsed}/${goal.maxTurns}`);
    console.log(`scratchpad: ${goal.scratchpad}\n`);
    for (const t of goal.transcript) {
      console.log(
        `--- ${t.participant} (turn ${t.turn}) ---\n` +
        `reply content not retained; completion declared: ${t.completionDeclared ? 'yes' : 'no'}\n`,
      );
    }
    console.log(LEGACY_ORCHESTRATE_NOTICE);
    return;
  }

  if (command !== 'run' || !args[0]) {
    usage();
    process.exitCode = command ? 1 : 0;
    return;
  }

  const turns = Number.parseInt(flag(args, '--turns') ?? '', 10);
  console.warn(LEGACY_ORCHESTRATE_NOTICE);
  const goal = await runGoal({
    objective: args[0],
    mode: (flag(args, '--mode') as RunMode | undefined) ?? 'debate',
    maxTurns: Number.isFinite(turns) && turns > 0 ? turns : undefined,
    models: {
      ...(flag(args, '--codex') ? { codex: flag(args, '--codex') } : {}),
      ...(flag(args, '--claude') ? { claude: flag(args, '--claude') } : {}),
    },
    efforts: {
      ...(flag(args, '--codex-effort') ? { codex: flag(args, '--codex-effort') } : {}),
      ...(flag(args, '--claude-effort') ? { claude: flag(args, '--claude-effort') } : {}),
    },
    scratchpadRoot: flag(args, '--scratchpad'),
    onEvent: (e) => console.log(e),
  });

  console.log(`\nfinal status: ${goal.status} (${goal.turnsUsed} turns)`);
  console.log(`metadata only: orchestrate show ${goal.id}`);
  console.log('For the recommended durable workflow path: multicli studio');
  process.exitCode = goal.status === 'failed' ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
