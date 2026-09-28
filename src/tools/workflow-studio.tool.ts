import { z } from 'zod';

import { createLunaBuildCouncilDefinition } from '../workflows/lunaBuildCouncil.js';
import { studioCliLaunchHandoff } from '../studio/launchCommand.js';
import { canonicalWorkspace } from '../utils/canonicalWorkspace.js';
import type { UnifiedTool } from './registry.js';
import { workflowToolRuntime } from './workflow-tool-runtime.js';

export function workflowRunStudioCommand(
  runId: string,
  workspace?: string,
  storePath?: string,
): string {
  return studioCliLaunchHandoff({
    runId,
    ...(workspace ? { workspace } : {}),
    ...(storePath ? { storePath } : {}),
  }).displayCommand;
}

export const startLunaBuildCouncilTool: UnifiedTool = {
  name: 'Start-Luna-Build-Council',
  description:
    'Start a durable local workflow led by Sol with 2–20 Luna MAX builder lanes. ' +
    'The workflow uses installed provider CLIs with CLI-owned authentication, stores events and artifacts locally, ' +
    'runs the repository harness, and pauses at an exact-action human review gate.',
  category: 'utility',
  execution: { taskSupport: 'optional' },
  timeoutClass: 'none',
  zodSchema: z.object({
    objective: z.string().min(1).describe('The concrete objective for the council.'),
    builderCount: z.number().int().min(2).max(20).default(5)
      .describe('Independent Luna MAX builder lanes. Defaults to five; maximum twenty.'),
  }),
  execute: async (args, context) => {
    const cwd = canonicalWorkspace(context?.cwd ?? process.cwd());
    const services = workflowToolRuntime(cwd, context?.logger);
    const revision = createLunaBuildCouncilDefinition({
      builderCount: args.builderCount as number,
    });
    const durableRevision = services.controlPlane.publishWorkflow({
      workflowId: revision.id,
      definition: revision,
    });
    const snapshot = services.controlPlane.startRun({
      workflowRevisionId: durableRevision.id,
      workspace: cwd,
      runInput: { objective: args.objective, workspace: cwd },
    });
    const stop = () => services.runner.stop(snapshot.run.id, 'MCP request cancelled');
    context?.signal?.addEventListener('abort', stop, { once: true });
    context?.onProgress?.(`Started Sol conductor with ${args.builderCount} Luna MAX lanes.\n`);
    try {
      await services.runner.execute(snapshot.run.id);
    } finally {
      context?.signal?.removeEventListener('abort', stop);
    }
    const result = services.controlPlane.getRunSnapshot(snapshot.run.id);
    const studioLaunch = services.storePath === ':memory:'
      ? undefined
      : studioCliLaunchHandoff({
        runId: result.run.id,
        workspace: cwd,
        storePath: services.storePath,
      });
    return JSON.stringify({
      runId: result.run.id,
      status: result.run.status,
      workflowRevisionId: result.workflowRevision.id,
      lastSequence: result.run.lastSequence,
      pendingApprovals: result.approvals.map(approval => ({
        id: approval.id,
        actionHash: approval.actionHash,
        risk: approval.risk,
        expiresAt: approval.expiresAt,
      })),
      artifacts: result.artifacts.map(artifact => ({
        id: artifact.id,
        name: artifact.name,
        location: artifact.location,
        contentHash: artifact.contentHash,
      })),
      studio: studioLaunch
        ? `Run \`${studioLaunch.displayCommand}\` to inspect this run locally.`
        : 'Studio handoff is unavailable because this run uses an in-memory ledger.',
      ...(studioLaunch
        ? {
          studioLaunch: {
            command: studioLaunch.command,
            args: studioLaunch.args,
            displayCommand: studioLaunch.displayCommand,
          },
        }
        : {}),
    }, null, 2);
  },
};

export const listWorkflowRunsTool: UnifiedTool = {
  name: 'List-Workflow-Runs',
  description: 'List recent durable local orchestration runs without returning prompt or artifact contents.',
  category: 'utility',
  timeoutClass: 'none',
  zodSchema: z.object({
    limit: z.number().int().min(1).max(100).default(20),
  }),
  execute: async (args, context) => {
    const services = workflowToolRuntime(context?.cwd ?? process.cwd(), context?.logger);
    return JSON.stringify({ runs: services.controlPlane.listRuns(args.limit as number) }, null, 2);
  },
};

export const getWorkflowRunTool: UnifiedTool = {
  name: 'Get-Workflow-Run',
  description: 'Inspect one durable workflow run, its ordered event metadata, approvals, and artifact provenance.',
  category: 'utility',
  timeoutClass: 'none',
  zodSchema: z.object({ runId: z.string().uuid() }),
  execute: async (args, context) => {
    const services = workflowToolRuntime(context?.cwd ?? process.cwd(), context?.logger);
    return JSON.stringify(services.controlPlane.getRunSnapshot(args.runId as string), null, 2);
  },
};
