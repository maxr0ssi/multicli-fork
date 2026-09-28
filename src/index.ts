#!/usr/bin/env node
import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import { loadConfig } from './config.js';
import { startHttpServer } from './httpServer.js';
import { handleHarnessCommand } from './harness/cli.js';
import { createLogger } from './logger.js';
import { startServer as startStdioServer } from './serverApp.js';
import { handleServiceCommand } from './service/manager.js';
import {
  openLocalUrl,
  parseStudioLaunchArgs,
} from './studio/launcher.js';

interface ClosableRuntime {
  close(reason?: string): Promise<void>;
}

function parseCommand(argv: string[]): {
  command: 'serve-stdio' | 'serve-http' | 'service' | 'studio' | 'harness';
  args: string[];
} {
  const [firstArg, ...rest] = argv;

  if (firstArg === 'serve-http') {
    return { command: 'serve-http', args: rest };
  }

  if (firstArg === 'serve-stdio') {
    return { command: 'serve-stdio', args: rest };
  }

  if (firstArg === 'service') {
    return { command: 'service', args: rest };
  }

  if (firstArg === 'studio') {
    return { command: 'studio', args: rest };
  }

  if (firstArg === 'harness') {
    return { command: 'harness', args: rest };
  }

  return {
    command: loadConfig().transport === 'http' ? 'serve-http' : 'serve-stdio',
    args: argv,
  };
}

async function main() {
  const parsed = parseCommand(process.argv.slice(2));
  const config = loadConfig();
  const rootLogger = createLogger({
    filePath: config.logPath,
    fileLevel: config.logLevel,
    stderrLevel: config.stderrLogLevel,
    bindings: { component: 'multicli' },
  });
  const logger = rootLogger.child({ component: 'index' });

  logger.info('process_bootstrap', {
    config,
    argv: process.argv,
    parsedCommand: parsed.command,
    cwd: process.cwd(),
    nodeVersion: process.version,
    platform: process.platform,
  });

  if (parsed.command === 'service') {
    await handleServiceCommand(parsed.args, config, rootLogger);
    return;
  }

  if (parsed.command === 'harness') {
    process.exitCode = await handleHarnessCommand(parsed.args, config);
    return;
  }

  let runtime: ClosableRuntime;
  if (parsed.command === 'studio') {
    const launch = parseStudioLaunchArgs(parsed.args);
    const studioServer = await startHttpServer({
      ...config,
      ...(launch.storePath ? { runStorePath: launch.storePath } : {}),
      transport: 'http',
      httpHost: '127.0.0.1',
      httpPort: 0,
      httpAuthToken: randomBytes(32).toString('hex'),
    }, rootLogger, undefined, { workspace: launch.workspace });
    const launchUrl = studioServer.createStudioLaunchUrl(launch.target);
    process.stdout.write(`Studio: ${launchUrl}\n`);
    if (!launch.noOpen) {
      try {
        openLocalUrl(launchUrl);
      } catch (error) {
        logger.error('studio_browser_open_failed', { error });
        process.stdout.write('Open the Studio URL above in your browser.\n');
      }
    }
    runtime = studioServer;
  } else {
    runtime = parsed.command === 'serve-http'
      ? await startHttpServer({ ...config, transport: 'http' }, rootLogger)
      : await startStdioServer({ ...config, transport: 'stdio' }, rootLogger);
  }

  const shutdown = async (signalName: string) => {
    logger.info('process_signal_received', { signalName });
    await runtime.close(`Received ${signalName}`);
  };

  const handleFatalError = (event: string, error: unknown) => {
    logger.error(event, { error });
    process.exitCode = 1;
    void runtime.close(event);
    setTimeout(() => {
      process.exit(1);
    }, parsed.command === 'serve-http' ? 250 : 25).unref();
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('beforeExit', (code) => {
    logger.info('process_before_exit', { code });
  });
  process.once('exit', (code) => {
    logger.info('process_exit', { code });
  });
  process.on('warning', (warning) => {
    logger.error('process_warning', { warning });
  });
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    logger.error('process_uncaught_exception_monitor', { error, origin });
  });
  process.on('uncaughtException', (error, origin) => {
    handleFatalError('process_uncaught_exception', { error, origin });
  });
  process.on('unhandledRejection', (reason, promise) => {
    handleFatalError('process_unhandled_rejection', { reason, promise });
  });
}

main().catch((error) => {
  const config = loadConfig();
  const rootLogger = createLogger({
    filePath: config.logPath,
    fileLevel: config.logLevel,
    stderrLevel: config.stderrLogLevel,
    bindings: { component: 'multicli' },
  });
  const logger = rootLogger.child({ component: 'index' });
  logger.error('server_startup_failed', { error });
  process.exit(1);
});
