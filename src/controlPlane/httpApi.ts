import type { Logger } from '../logger.js';
import type { LocalControlPlane } from './controlPlane.js';
import {
  WorkflowDraftValidationError,
  assertWorkflowDraftDefinitionLimits,
  type ApprovalRecord,
} from '../persistence/runLedger.js';
import {
  StudioAuthManager,
} from './studioAuth.js';
import {
  headerValue,
  studioAuthMiddleware,
  studioPrincipalFrom,
  studioSecurityHeaders,
} from '../studio/server/httpSecurity.js';
import { mountStudioQueryRoutes } from '../studio/server/studioRoutes.js';
import { mountStudioGoalSessionRoutes } from '../studio/server/goalSessionRoutes.js';
import type { StudioGoalSessionCommands } from '../studio/server/goalSessionCommands.js';
import {
  StudioQueryService,
  type StudioQueryServiceOptions,
} from '../studio/server/studioQueryService.js';
import { studioAsset } from '../studio/studioAssets.js';
import { mountWorkflowDraftRoutes } from './workflowDraftRoutes.js';
import {
  preflightWorkflowStart,
  WorkflowStartPreflightError,
} from './workflowDraftCapabilities.js';
import { normalizeWorkflowDraftDefinition } from '../workflows/drafts.js';
import { validateLocalWorkflowRevision } from '../workflows/localModelPolicy.js';

const API_PATH = '/api/v1';
const STUDIO_PATH = '/studio';

export interface LocalControlApiOptions {
  app: any;
  controlPlane: LocalControlPlane;
  auth: StudioAuthManager;
  logger: Logger;
  host: string;
  renderStudio: () => string;
  getCapabilities?: () => unknown;
  onRunStarted?: (runId: string) => void | Promise<void>;
  onRunControl?: (
    runId: string,
    action: 'pause' | 'resume' | 'cancel',
  ) => void | Promise<void>;
  onApprovalResolved?: (approval: ApprovalRecord) => void | Promise<void>;
  heartbeatMs?: number;
  studio?: {
    queryService?: StudioQueryService;
    workspace?: string;
    artifactRoot?: string;
    goalSessionsEnabled?: boolean;
    artifactPreviewBytes?: number;
    maxArtifactBytes?: number;
    goalSessionCommands?: StudioGoalSessionCommands;
  };
}

export interface MountedLocalControlApi {
  apiPath: string;
  studioPath: string;
  close(): void;
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Unknown ')) return 404;
  if (message.includes('terminal') || message.includes('sequence conflict')) return 409;
  if (error instanceof WorkflowDraftValidationError
    || error instanceof WorkflowStartPreflightError) return 422;
  if (message.includes('too large') || message.includes('too many')) return 413;
  return 400;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function wrap(
  logger: Logger,
  handler: (req: any, res: any) => void | Promise<void>,
) {
  return async (req: any, res: any) => {
    try {
      await handler(req, res);
    } catch (error) {
      logger.error('control_api_request_failed', {
        method: req.method,
        path: req.path,
        error,
      });
      if (!res.headersSent) {
        const validation = error instanceof WorkflowDraftValidationError
          || error instanceof WorkflowStartPreflightError
          ? error.validation
          : undefined;
        res.status(errorStatus(error)).json({
          error: errorMessage(error),
          ...(validation ? { validation } : {}),
        });
      }
    }
  };
}

function defaultCapabilities() {
  return {
    locality: {
      controlPlane: 'loopback-only',
      state: 'local-sqlite',
      providerAccess: 'installed-cli-owned-auth',
      directProviderApiKeys: false,
    },
    features: {
      durableRuns: true,
      replayableEvents: true,
      approvals: true,
      artifacts: true,
      harness: true,
      workflowDrafts: true,
    },
  };
}

export function mountLocalControlApi(
  options: LocalControlApiOptions,
): MountedLocalControlApi {
  const {
    app,
    auth,
    controlPlane,
    host,
    logger,
    renderStudio,
  } = options;
  const intervals = new Set<NodeJS.Timeout>();
  const eventStreams = new Set<any>();
  const authenticate = studioAuthMiddleware(auth, host);

  app.get(`${STUDIO_PATH}/session`, (req: any, res: any) => {
    studioSecurityHeaders(res);
    const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : '';
    const session = auth.exchangeLaunchNonce(nonce);
    if (!session) {
      res.status(401).send('This Studio launch link is invalid or has expired.');
      return;
    }
    res.setHeader('Set-Cookie', auth.sessionCookie(session));
    res.redirect(303, session.returnTo ?? STUDIO_PATH);
  });

  app.get(STUDIO_PATH, authenticate, (_req: any, res: any) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.type('html').send(renderStudio());
  });

  app.get(`${STUDIO_PATH}/assets/:assetName`, authenticate, (req: any, res: any) => {
    const asset = studioAsset(req.params.assetName);
    if (!asset) {
      res.status(404).json({ error: 'Unknown Studio asset' });
      return;
    }
    res.type(asset.contentType).sendFile(asset.path);
  });

  app.use(API_PATH, authenticate);

  const queryOptions: StudioQueryServiceOptions = {
    controlPlane,
    workspace: options.studio?.workspace ?? process.cwd(),
    ...(options.studio?.artifactRoot ? { artifactRoot: options.studio.artifactRoot } : {}),
    ...(options.studio?.goalSessionsEnabled === undefined
      ? {}
      : { goalSessionsEnabled: options.studio.goalSessionsEnabled }),
    ...(options.studio?.artifactPreviewBytes === undefined
      ? {}
      : { artifactPreviewBytes: options.studio.artifactPreviewBytes }),
    ...(options.studio?.maxArtifactBytes === undefined
      ? {}
      : { maxArtifactBytes: options.studio.maxArtifactBytes }),
  };
  mountStudioQueryRoutes({
    app,
    query: options.studio?.queryService ?? new StudioQueryService(queryOptions),
    logger: logger.child({ component: 'studioQueries' }),
  });
  if (options.studio?.goalSessionCommands) {
    mountStudioGoalSessionRoutes({
      app,
      commands: options.studio.goalSessionCommands,
      logger: logger.child({ component: 'studioGoalSessions' }),
    });
  }
  mountWorkflowDraftRoutes({
    app,
    controlPlane,
    logger: logger.child({ component: 'workflowDrafts' }),
    workspace: queryOptions.workspace,
    ...(options.getCapabilities ? { getRuntimeCapabilities: options.getCapabilities } : {}),
    ...(options.onRunStarted ? { onRunStarted: options.onRunStarted } : {}),
  });

  app.get(`${API_PATH}/session`, (req: any, res: any) => {
    const principal = studioPrincipalFrom(req);
    res.json({
      authenticated: true,
      mode: principal.kind,
      csrfToken: principal.csrfToken ?? null,
      expiresAt: principal.expiresAt ?? null,
    });
  });

  app.post(`${API_PATH}/logout`, (req: any, res: any) => {
    auth.revoke(headerValue(req.headers.cookie));
    res.setHeader('Set-Cookie', auth.clearSessionCookie());
    res.status(204).end();
  });

  app.get(`${API_PATH}/capabilities`, (_req: any, res: any) => {
    res.json(options.getCapabilities?.() ?? defaultCapabilities());
  });

  app.post(`${API_PATH}/workflows`, wrap(logger, (req, res) => {
    const workflowId = requireString(req.body?.workflowId, 'workflowId');
    if (req.body?.definition === undefined) {
      throw new Error('definition is required');
    }
    if (req.body?.id !== undefined) {
      throw new Error('Workflow revision id is server-assigned');
    }
    const definition = normalizeWorkflowDraftDefinition(workflowId, 1, req.body.definition);
    assertWorkflowDraftDefinitionLimits(definition);
    const validation = validateLocalWorkflowRevision(definition);
    if (!validation.valid) {
      throw new WorkflowDraftValidationError('direct-publish', validation);
    }
    const draft = controlPlane.createWorkflowDraft({
      workflowId,
      definition,
    });
    const published = controlPlane.publishWorkflowDraft({
      id: draft.id,
      expectedVersion: draft.version,
    });
    res.status(201).json(published.workflowRevision);
  }));

  app.get(`${API_PATH}/workflows`, (_req: any, res: any) => {
    res.json({ workflows: controlPlane.ledger.listWorkflowRevisions() });
  });

  app.get(`${API_PATH}/runs`, (req: any, res: any) => {
    const requested = Number.parseInt(String(req.query.limit ?? '100'), 10);
    res.json({ runs: controlPlane.listRuns(Number.isFinite(requested) ? requested : 100) });
  });

  app.post(`${API_PATH}/runs`, wrap(logger, async (req, res) => {
    const workflowRevisionId = requireString(
      req.body?.workflowRevisionId,
      'workflowRevisionId',
    );
    const workflowRevision = controlPlane.ledger.getWorkflowRevision(workflowRevisionId);
    if (!workflowRevision) {
      throw new Error(`Unknown workflow revision: ${workflowRevisionId}`);
    }
    assertWorkflowDraftDefinitionLimits(workflowRevision.definition);
    const preflight = preflightWorkflowStart(
      workflowRevision.definition,
      options.getCapabilities?.(),
    );
    if (!preflight.valid) throw new WorkflowStartPreflightError(preflight);
    const snapshot = controlPlane.startRun({
      ...(typeof req.body.id === 'string' ? { id: req.body.id } : {}),
      workflowRevisionId,
      workspace: queryOptions.workspace,
      ...(req.body?.input !== undefined ? { runInput: req.body.input } : {}),
      ...(typeof req.body?.parentRunId === 'string'
        ? { parentRunId: req.body.parentRunId }
        : {}),
    });
    await options.onRunStarted?.(snapshot.run.id);
    res.status(201).json(snapshot);
  }));

  app.get(`${API_PATH}/runs/:runId`, wrap(logger, (req, res) => {
    res.json(controlPlane.getRunSnapshot(req.params.runId));
  }));

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`${API_PATH}/runs/:runId/${action}`, wrap(logger, async (req, res) => {
      const snapshot = action === 'pause'
        ? controlPlane.pauseRun(req.params.runId)
        : action === 'resume'
          ? controlPlane.resumeRun(req.params.runId)
          : controlPlane.cancelRun(req.params.runId);
      await options.onRunControl?.(req.params.runId, action);
      res.json(snapshot);
    }));
  }

  app.get(`${API_PATH}/runs/:runId/events`, wrap(logger, (req, res) => {
    controlPlane.getRunSnapshot(req.params.runId);
    const headerCursor = headerValue(req.headers['last-event-id']);
    const queryCursor = typeof req.query.after === 'string' ? req.query.after : undefined;
    const parsedCursor = Number.parseInt(queryCursor ?? headerCursor ?? '0', 10);
    const afterSequence = Number.isFinite(parsedCursor) ? Math.max(0, parsedCursor) : 0;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    eventStreams.add(res);

    const send = (event: ReturnType<LocalControlPlane['appendEvent']>) => {
      res.write(`id: ${event.sequence}\n`);
      res.write('event: run-event\n');
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of controlPlane.ledger.listAllEvents(req.params.runId, afterSequence)) {
      send(event);
    }
    const unsubscribe = controlPlane.subscribe(req.params.runId, send);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), options.heartbeatMs ?? 15_000);
    heartbeat.unref();
    intervals.add(heartbeat);
    req.on('close', () => {
      clearInterval(heartbeat);
      intervals.delete(heartbeat);
      eventStreams.delete(res);
      unsubscribe();
    });
  }));

  app.get(`${API_PATH}/approvals`, (req: any, res: any) => {
    const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
    res.json({ approvals: controlPlane.ledger.listPendingApprovals(runId) });
  });

  app.post(`${API_PATH}/approvals/:approvalId/resolve`, wrap(logger, async (req, res) => {
    const decision = req.body?.decision;
    if (decision !== 'approved' && decision !== 'denied') {
      throw new Error('decision must be approved or denied');
    }
    const approval = controlPlane.resolveApproval({
      id: req.params.approvalId,
      decision,
      decisionBy: studioPrincipalFrom(req).kind === 'studio'
        ? 'local-studio'
        : 'local-bearer',
      actionHash: requireString(req.body?.actionHash, 'actionHash'),
    });
    await options.onApprovalResolved?.(approval);
    res.json(approval);
  }));

  app.get(`${API_PATH}/runs/:runId/artifacts`, wrap(logger, (req, res) => {
    controlPlane.getRunSnapshot(req.params.runId);
    res.json({ artifacts: controlPlane.ledger.listArtifacts(req.params.runId) });
  }));

  return {
    apiPath: API_PATH,
    studioPath: STUDIO_PATH,
    close() {
      for (const stream of eventStreams) stream.end();
      eventStreams.clear();
      for (const interval of intervals) clearInterval(interval);
      intervals.clear();
    },
  };
}
