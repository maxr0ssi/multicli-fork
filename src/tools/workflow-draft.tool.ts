import path from 'node:path';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { LocalControlPlane } from '../controlPlane/controlPlane.js';
import type { Logger } from '../logger.js';
import { canonicalWorkspace } from '../utils/canonicalWorkspace.js';
import {
  createWorkflowDraftService,
  describeWorkflowDraftDesign,
  workflowDraftProposalSchema,
} from '../workflowDraftService.js';
import type { UnifiedTool } from './registry.js';
import { workflowToolRuntime } from './workflow-tool-runtime.js';

type DraftControlPlane = Pick<LocalControlPlane,
  | 'createWorkflowDraft'
  | 'getWorkflowDraft'
  | 'listWorkflowDrafts'
  | 'updateWorkflowDraft'
  | 'publishWorkflowDraft'
>;

export interface WorkflowDraftToolOptions {
  readonly getRuntime?: (cwd: string, logger?: Logger) => {
    readonly controlPlane: DraftControlPlane;
    readonly storePath: string;
  };
  readonly runtimeCapabilities?: unknown;
}

const readOnlyAnnotations: Tool['annotations'] = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
};

const createAnnotations: Tool['annotations'] = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: false,
};

export function createWorkflowDraftTools(options: WorkflowDraftToolOptions = {}): {
  readonly describeWorkflowDesignTool: UnifiedTool;
  readonly createWorkflowDraftTool: UnifiedTool;
} {

  return {
    describeWorkflowDesignTool: {
      name: 'Describe-Workflow-Design',
      description:
        'Return the machine-readable local workflow vocabulary, provider/model choices, ' +
        'agent caps, nested-agent policy, and exact editable-draft schemas. This is read-only.',
      category: 'utility',
      timeoutClass: 'none',
      annotations: readOnlyAnnotations,
      zodSchema: z.object({}).strict(),
      execute: async () => JSON.stringify(
        describeWorkflowDraftDesign(options.runtimeCapabilities), null, 2,
      ),
    },
    createWorkflowDraftTool: {
      name: 'Create-Workflow-Draft',
      description:
        'Persist an exact typed workflow proposal and separate run context as an editable local draft. ' +
        'Returns the resolved topology, server validation and policy evidence, and the secure ' +
        '`multicli studio --draft <id> --workspace <workspace> --store <runStorePath>` command and ' +
        'structured argv for a file-backed ledger. In-memory ledgers return an explicit unavailable ' +
        'Studio handoff. It never publishes, starts, or executes the workflow.',
      category: 'utility',
      timeoutClass: 'none',
      annotations: createAnnotations,
      zodSchema: workflowDraftProposalSchema,
      execute: async (args, context) => {
        const input = workflowDraftProposalSchema.parse(args);
        const cwd = canonicalWorkspace(path.resolve(context?.cwd ?? process.cwd()));
        const runtime = options.getRuntime
          ? options.getRuntime(cwd, context?.logger)
          : workflowToolRuntime({ ...context, cwd });
        return JSON.stringify(
          createWorkflowDraftService(runtime.controlPlane).propose({
            ...input,
            proposedRunInput: {
              ...input.proposedRunInput,
              workspace: cwd,
            },
          }, { storePath: runtime.storePath }),
          null,
          2,
        );
      },
    },
  };
}

const defaultTools = createWorkflowDraftTools();
export const describeWorkflowDesignTool = defaultTools.describeWorkflowDesignTool;
export const createWorkflowDraftTool = defaultTools.createWorkflowDraftTool;
