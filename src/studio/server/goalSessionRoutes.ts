import type { Logger } from '../../logger.js';
import type { StudioGoalSessionCommands } from './goalSessionCommands.js';

const API_PATH = '/api/v1';

function statusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Unknown ')) return 404;
  if (message.includes('terminal') || message.includes('in flight')) return 409;
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
      logger.error('studio_goal_command_failed', {
        method: req.method,
        path: req.path,
        error,
      });
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(statusFor(error)).json({ error: message });
      }
    }
  };
}

export function mountStudioGoalSessionRoutes(options: {
  app: any;
  commands: StudioGoalSessionCommands;
  logger: Logger;
}): void {
  const { app, commands, logger } = options;
  app.post(`${API_PATH}/goal-sessions`, wrap(logger, (req, res) => {
    const session = commands.open({
      runId: req.body?.runId,
      profileId: req.body?.profileId,
      goal: req.body?.goal,
    });
    res.status(201).json(session);
  }));
  app.post(
    `${API_PATH}/goal-sessions/:sessionId/instructions`,
    wrap(logger, (req, res) => {
      res.status(202).json(commands.instruct(
        req.params.sessionId,
        req.body?.instruction,
      ));
    }),
  );
  app.post(
    `${API_PATH}/goal-sessions/:sessionId/close`,
    wrap(logger, async (req, res) => {
      res.json(await commands.close(req.params.sessionId));
    }),
  );
}
