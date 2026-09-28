import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { MultiCliConfig } from '../config.js';
import { PROTOCOL } from '../constants.js';
import type { Logger } from '../logger.js';

export type ProgressToken = string | number | undefined;
export type ProgressStatus = 'success' | 'failed' | 'cancelled';

export interface ProgressReporter {
  start(): Promise<void>;
  onOutput(chunk: string): void;
  stop(status: ProgressStatus): Promise<void>;
}

function extractProgressPreview(chunk: string): string | undefined {
  const lines = chunk
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const preview = lines.at(-1) ?? chunk.trim();
  if (!preview) {
    return undefined;
  }

  return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
}

export function createProgressReporter(
  server: Server,
  logger: Logger,
  config: MultiCliConfig,
  progressToken: ProgressToken,
  operationName: string,
): ProgressReporter {
  let completed = false;
  let stopping = false;
  let timeout: NodeJS.Timeout | undefined;
  let progress = 0;
  let lastOutputAt = Date.now();
  let lastNotificationAt = 0;
  let latestPreview: string | undefined;
  let queuedWork: Promise<void> = Promise.resolve();

  const queueProgressWork = (work: () => Promise<void>) => {
    queuedWork = queuedWork.then(work, work);
    return queuedWork;
  };

  const waitForQueuedWork = async () => {
    try {
      await queuedWork;
    } catch (error) {
      logger.debug('progress_work_failed', { operationName, error });
    }
  };

  const sendProgressNotification = async (
    currentProgress: number,
    message: string,
    total?: number,
  ) => {
    if (progressToken === undefined || progressToken === null) {
      return;
    }

    try {
      const params: Record<string, unknown> = {
        progressToken,
        progress: currentProgress,
        message,
      };
      if (total !== undefined) {
        params.total = total;
      }

      await server.notification({
        method: PROTOCOL.NOTIFICATIONS.PROGRESS,
        params,
      });
      lastNotificationAt = Date.now();
    } catch (error) {
      logger.debug('progress_notification_failed', { operationName, error });
    }
  };

  const flushPreview = async (force = false, allowWhileStopping = false) => {
    if (completed || (!allowWhileStopping && stopping) || !latestPreview) {
      return;
    }

    if (!force && Date.now() - lastNotificationAt < config.progressThrottleMs) {
      return;
    }

    const preview = latestPreview;
    latestPreview = undefined;
    progress += 1;
    await sendProgressNotification(progress, preview);
  };

  const scheduleHeartbeat = () => {
    timeout = setTimeout(() => {
      void queueProgressWork(async () => {
        if (completed || stopping) {
          return;
        }

        if (latestPreview) {
          await flushPreview(true);
        } else if (Date.now() - lastOutputAt >= config.progressIdleHeartbeatMs) {
          progress += 1;
          await sendProgressNotification(progress, `Still running ${operationName}...`);
        }
      }).finally(() => {
        if (!completed && !stopping) {
          scheduleHeartbeat();
        }
      });
    }, config.progressIdleHeartbeatMs);
  };

  return {
    start: async () => {
      await queueProgressWork(async () => {
        await sendProgressNotification(0, `Starting ${operationName}`);
      });
      scheduleHeartbeat();
    },
    onOutput: (chunk: string) => {
      if (completed || stopping) {
        return;
      }

      lastOutputAt = Date.now();
      const preview = extractProgressPreview(chunk);
      if (!preview) {
        return;
      }

      latestPreview = preview;
      if (Date.now() - lastNotificationAt >= config.progressThrottleMs) {
        void queueProgressWork(async () => {
          await flushPreview(true);
        });
      }
    },
    stop: async (status: ProgressStatus) => {
      if (stopping) {
        await waitForQueuedWork();
        return;
      }

      stopping = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      await queueProgressWork(async () => {
        await flushPreview(true, true);
        completed = true;

        const label = status === 'success'
          ? 'Completed'
          : status === 'cancelled' ? 'Cancelled' : 'Failed';
        await sendProgressNotification(100, `${label} ${operationName}`, 100);
      });

      await waitForQueuedWork();
    },
  };
}
