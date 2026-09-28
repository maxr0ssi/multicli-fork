import type { Logger } from '../../logger.js';
import type { StudioQueryService } from './studioQueryService.js';

const API_PATH = '/api/v1';

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Unknown ')) return 404;
  if (message.includes('too large')) return 413;
  if (message.includes('integrity') || message.includes('changed while')) return 409;
  return 400;
}

function wrap(
  logger: Logger,
  handler: (req: any, res: any) => void | Promise<void>,
) {
  return async (req: any, res: any) => {
    try {
      await handler(req, res);
    } catch (error) {
      logger.error('studio_query_failed', {
        method: req.method,
        path: req.path,
        error,
      });
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(errorStatus(error)).json({ error: message });
      }
    }
  };
}

export function mountStudioQueryRoutes(options: {
  app: any;
  query: StudioQueryService;
  logger: Logger;
}): void {
  const { app, logger, query } = options;
  app.get(`${API_PATH}/studio/bootstrap`, wrap(logger, (req, res) => {
    const requested = Number.parseInt(String(req.query.limit ?? '100'), 10);
    res.json(query.bootstrap(Number.isFinite(requested) ? requested : 100));
  }));
  app.get(`${API_PATH}/runs/:runId/view`, wrap(logger, (req, res) => {
    res.json(query.getRunView(req.params.runId));
  }));
  app.get(`${API_PATH}/workflows/:revisionId`, wrap(logger, (req, res) => {
    res.json(query.getWorkflow(req.params.revisionId));
  }));
  app.get(
    `${API_PATH}/runs/:runId/artifacts/:artifactId/content`,
    wrap(logger, (req, res) => {
      res.json(query.getArtifactPreview(req.params.runId, req.params.artifactId));
    }),
  );
}
