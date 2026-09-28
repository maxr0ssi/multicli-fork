import type { Logger } from '../logger.js';
import {
  assertWorkflowDraftDefinitionLimits,
  WorkflowDraftValidationError,
  WorkflowDraftVersionConflictError,
} from '../persistence/runLedger.js';
import type { LocalControlPlane } from './controlPlane.js';
import {
  preflightWorkflowStart,
  workflowDraftCapabilities,
  WorkflowStartPreflightError,
} from './workflowDraftCapabilities.js';

const API_PATH = '/api/v1';

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof WorkflowDraftValidationError
    || error instanceof WorkflowStartPreflightError) return 422;
  if (message.startsWith('Unknown ')) return 404;
  if (message.includes('version conflict') || message.includes('published; fork')
    || message.includes('was published without') || message.includes('already bound')) return 409;
  if (message.includes('too large') || message.includes('too many')) return 413;
  return 400;
}

function wrap(
  logger: Logger,
  handler: (req: any, res: any) => void | Promise<void>,
  conflictRecovery?: (req: any, error: WorkflowDraftVersionConflictError) => unknown,
) {
  return async (req: any, res: any) => {
    try {
      await handler(req, res);
    } catch (error) {
      logger.error('workflow_draft_request_failed', {
        method: req.method,
        path: req.path,
        error,
      });
      if (res.headersSent) return;
      const message = error instanceof Error ? error.message : String(error);
      const validation = error instanceof WorkflowDraftValidationError
        || error instanceof WorkflowStartPreflightError ? error.validation : undefined;
      const conflict = error instanceof WorkflowDraftVersionConflictError ? {
        expectedVersion: error.expectedVersion,
        currentVersion: error.currentVersion,
        ...(conflictRecovery ? { recovery: conflictRecovery(req, error) } : {}),
      } : undefined;
      const body = { error: message, ...(validation ? { validation } : {}), ...conflict };
      res.status(errorStatus(error)).json(body);
    }
  };
}

function expectedVersion(value: unknown, required = true): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('expectedVersion must be a positive integer');
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function mountWorkflowDraftRoutes(options: {
  app: any;
  controlPlane: LocalControlPlane;
  logger: Logger;
  getRuntimeCapabilities?: () => unknown;
  workspace: string;
  onRunStarted?: (runId: string) => void | Promise<void>;
}): void {
  const { app, controlPlane, logger } = options;
  app.post(`${API_PATH}/workflow-drafts`, wrap(logger, (req, res) => {
    const draft = controlPlane.createWorkflowDraft({
      ...(optionalString(req.body?.id) ? { id: optionalString(req.body.id) } : {}),
      ...(optionalString(req.body?.workflowId)
        ? { workflowId: optionalString(req.body.workflowId) } : {}),
      ...(req.body?.definition === undefined ? {} : { definition: req.body.definition }),
      ...(Object.hasOwn(req.body ?? {}, 'proposedRunInput')
        ? { proposedRunInput: req.body.proposedRunInput } : {}),
      ...(optionalString(req.body?.sourceRevisionId)
        ? { sourceRevisionId: optionalString(req.body.sourceRevisionId) } : {}),
    });
    res.status(201).json(draft);
  }));

  app.get(`${API_PATH}/workflow-drafts/capabilities`, (_req: any, res: any) => {
    res.json(workflowDraftCapabilities(options.getRuntimeCapabilities?.()));
  });

  app.get(`${API_PATH}/workflow-drafts`, (req: any, res: any) => {
    res.json({
      drafts: controlPlane.listWorkflowDrafts(optionalString(req.query.workflowId)),
    });
  });
  app.get(`${API_PATH}/workflow-drafts/:draftId`, wrap(logger, (req, res) => {
    res.json(controlPlane.getWorkflowDraft(req.params.draftId));
  }));
  app.put(`${API_PATH}/workflow-drafts/:draftId`, wrap(logger, (req, res) => {
    if (req.body?.definition === undefined) throw new Error('definition is required');
    const result = controlPlane.updateWorkflowDraft({
      id: req.params.draftId,
      expectedVersion: expectedVersion(req.body?.expectedVersion)!,
      definition: req.body.definition,
      ...(Object.hasOwn(req.body ?? {}, 'proposedRunInput')
        ? { proposedRunInput: req.body.proposedRunInput } : {}),
    });
    if (result.forkedFromDraftId) {
      res.setHeader('Location', `${API_PATH}/workflow-drafts/${encodeURIComponent(result.draft.id)}`);
      res.status(201);
    }
    res.json(result);
  }, (req, error) => {
    const current = controlPlane.getWorkflowDraft(error.draftId);
    const sourceRevisionId = current.publishedRevisionId ?? current.baseRevisionId;
    return {
      action: 'save-as-new-draft',
      label: 'Save my changes as a new draft',
      command: {
        method: 'POST',
        path: `${API_PATH}/workflow-drafts`,
        body: {
          workflowId: current.workflowId,
          definition: req.body.definition,
          ...(Object.hasOwn(req.body ?? {}, 'proposedRunInput')
            ? { proposedRunInput: req.body.proposedRunInput } : {}),
          ...(sourceRevisionId ? { sourceRevisionId } : {}),
        },
      },
    };
  }));
  app.post(`${API_PATH}/workflow-drafts/:draftId/validate`, wrap(logger, (req, res) => {
    res.json(controlPlane.getWorkflowDraft(
      req.params.draftId,
      expectedVersion(req.body?.expectedVersion, false),
    ));
  }));
  app.post(`${API_PATH}/workflow-drafts/:draftId/publish`, wrap(logger, (req, res) => {
    res.json(controlPlane.publishWorkflowDraft({
      id: req.params.draftId,
      expectedVersion: expectedVersion(req.body?.expectedVersion)!,
    }));
  }));
  app.post(`${API_PATH}/workflow-drafts/:draftId/publish-and-start`, wrap(
    logger,
    async (req, res) => {
      const version = expectedVersion(req.body?.expectedVersion)!;
      const runId = optionalString(req.body?.runId);
      if (!runId) throw new Error('runId must be a non-empty stable idempotency key');
      const draft = controlPlane.getWorkflowDraft(req.params.draftId);
      const retryVersion = draft.publishedRevisionId && draft.version === version + 1;
      if (draft.version !== version && !retryVersion) {
        throw new WorkflowDraftVersionConflictError(draft.id, version, draft.version);
      }
      const committedReplay = retryVersion && controlPlane.ledger.getRun(runId);
      if (!committedReplay) {
        assertWorkflowDraftDefinitionLimits(draft.definition);
        const preflight = preflightWorkflowStart(
          draft.definition,
          options.getRuntimeCapabilities?.(),
        );
        if (!preflight.valid) throw new WorkflowStartPreflightError(preflight);
      }
      const result = controlPlane.publishAndStartWorkflowDraft({
        id: draft.id,
        expectedVersion: version,
        run: {
          id: runId,
          workspace: options.workspace,
          input: Object.hasOwn(req.body ?? {}, 'input')
            ? req.body.input : draft.proposedRunInput,
        },
      });
      if (result.runCreated) await options.onRunStarted?.(result.run.run.id);
      res.status(result.runCreated ? 201 : 200).json(result);
    },
  ));
}
