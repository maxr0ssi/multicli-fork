import os from 'node:os';
import path from 'node:path';

import {
  createClaudeDeepDeliveryWorkflow,
  createClaudeDeepThinkWorkflow,
  createLocalOrchestrator,
} from '../dist/publicApi.js';

const rawArgs = process.argv.slice(2);
const write = rawArgs.includes('--write');
const enableSubagents = rawArgs.includes('--enable-subs');
const dryRun = rawArgs.includes('--dry-run');
const objective = rawArgs
  .filter(argument => !['--write', '--enable-subs', '--dry-run'].includes(argument))
  .join(' ')
  .trim();

if (!objective) {
  throw new Error(
    'Usage: npm run try:claude -- [--write] [--enable-subs] [--dry-run] "your big task"',
  );
}

const workflow = write
  ? createClaudeDeepDeliveryWorkflow({ enableSubagents })
  : createClaudeDeepThinkWorkflow({ enableSubagents });

if (dryRun) {
  process.stdout.write(`${JSON.stringify({
    id: workflow.id,
    mode: write ? 'write' : 'read-only',
    enableSubagents,
    profiles: workflow.profiles,
    nodes: workflow.nodes.map(node => ({ id: node.id, kind: node.kind })),
  }, null, 2)}\n`);
  process.exit(0);
}

const storePath = process.env.MULTICLI_RUN_STORE_PATH
  ?? path.join(os.homedir(), '.multicli', 'studio', 'runs.sqlite');
const local = createLocalOrchestrator({
  workspace: process.cwd(),
  storePath,
  artifactRoot: path.join(path.dirname(storePath), 'artifacts'),
});

const unsubscribe = local.subscribe('*', event => {
  process.stderr.write(`${event.sequence} ${event.type}\n`);
});

try {
  const snapshot = await local.run(workflow, { objective });
  process.stdout.write(`${JSON.stringify({
    runId: snapshot.run.id,
    status: snapshot.run.status,
    storePath,
    approvals: snapshot.approvals.map(item => ({ id: item.id, actionHash: item.actionHash })),
    artifacts: snapshot.artifacts.map(item => item.location),
    next: snapshot.approvals.length > 0
      ? 'Inspect artifacts and approve or deny the exact action in Studio.'
      : 'The workflow reached a terminal state.',
  }, null, 2)}\n`);
} finally {
  unsubscribe();
  await local.close();
}
