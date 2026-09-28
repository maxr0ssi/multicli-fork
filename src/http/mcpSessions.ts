import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { MultiCliConfig } from '../config.js';
import type { Logger } from '../logger.js';
import {
  createServerApp,
  resolveWorkingDirectoryFromRoots,
  type MultiCliRuntime,
  type MultiCliServerApp,
  type MultiCliSessionContext,
} from '../serverApp.js';
import type { HttpMiddleware } from './security.js';

interface HttpSessionRecord {
  readonly sessionId: string;
  readonly app: MultiCliServerApp;
  readonly transport: StreamableHTTPServerTransport;
  readonly logger: Logger;
  lastActivityAt: number;
  idleTimer?: NodeJS.Timeout;
  closing: boolean;
}

interface McpHttpSessionHostOptions {
  readonly config: MultiCliConfig;
  readonly logger: Logger;
  readonly rootLogger: Logger;
  readonly runtime: MultiCliRuntime;
}

export class McpHttpSessionHost {
  readonly #sessions = new Map<string, HttpSessionRecord>();

  constructor(private readonly options: McpHttpSessionHostOptions) {}

  get size(): number {
    return this.#sessions.size;
  }

  mount(
    app: any,
    originValidation: HttpMiddleware,
    authValidation: HttpMiddleware,
  ): void {
    const path = this.options.config.httpPath;
    app.use(path, originValidation, authValidation);
    app.post(path, (req: any, res: any) => this.#handlePost(req, res));
    app.get(path, (req: any, res: any) => this.#handleExisting(req, res));
    app.delete(path, (req: any, res: any) => this.#handleExisting(req, res));
  }

  async close(reason: string): Promise<void> {
    await Promise.all(
      [...this.#sessions.keys()].map(sessionId => this.#cleanupSession(sessionId, reason)),
    );
  }

  #touchSession(record: HttpSessionRecord): void {
    record.lastActivityAt = Date.now();
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = setTimeout(() => {
      if (record.app.hasActiveWork) {
        this.#touchSession(record);
        return;
      }
      void this.#cleanupSession(record.sessionId, 'session idle timeout');
    }, this.options.config.httpSessionIdleMs);
    record.idleTimer.unref();
  }

  async #cleanupSession(sessionId: string, reason: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (!record || record.closing) return;

    record.closing = true;
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = undefined;
    }
    this.#sessions.delete(sessionId);
    record.logger.info('http_session_closing', {
      reason,
      lastActivityAt: new Date(record.lastActivityAt).toISOString(),
    });

    try {
      await record.transport.close();
    } catch (error) {
      record.logger.error('http_session_transport_close_failed', { error, reason });
    }
    try {
      await record.app.close(reason);
    } catch (error) {
      record.logger.error('http_session_app_close_failed', { error, reason });
    }
  }

  async #handlePost(req: any, res: any): Promise<void> {
    const { config, logger, rootLogger, runtime } = this.options;
    const requestLogger = logger.child({
      component: 'httpRequest',
      method: 'POST',
      path: req.path,
      sessionId: req.headers['mcp-session-id'],
    });

    try {
      const sessionId = this.#sessionId(req);
      if (sessionId) {
        const existing = this.#sessions.get(sessionId);
        if (!existing) {
          requestLogger.error('http_session_missing', { sessionId });
          res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Unknown session' },
            id: null,
          });
          return;
        }
        this.#touchSession(existing);
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        requestLogger.error('http_initialize_required');
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'A new HTTP session must begin with initialize.',
          },
          id: null,
        });
        return;
      }

      const sessionContext: MultiCliSessionContext = {
        transport: 'http',
        resolveWorkingDirectory: async (server, sessionResolveLogger) => (
          resolveWorkingDirectoryFromRoots(server, sessionResolveLogger)
        ),
      };
      const sessionLogger = logger.child({ component: 'httpSession' });
      const sessionApp = await createServerApp(config, rootLogger, {
        runtime,
        sessionContext,
        onClientInitialized: async (server, _clientInfo, currentSessionContext) => {
          const resolved = await resolveWorkingDirectoryFromRoots(
            server,
            sessionLogger.child({ component: 'roots' }),
          );
          currentSessionContext.cwd = resolved.cwd ?? currentSessionContext.cwd;
          currentSessionContext.rootUri = resolved.rootUri;
          currentSessionContext.projectRoots = resolved.projectRoots;
        },
      });

      let sessionRecord: HttpSessionRecord | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: newSessionId => {
          sessionRecord = {
            sessionId: newSessionId,
            app: sessionApp,
            transport,
            logger: sessionLogger.child({ sessionId: newSessionId }),
            lastActivityAt: Date.now(),
            closing: false,
          };
          this.#sessions.set(newSessionId, sessionRecord);
          this.#touchSession(sessionRecord);
          sessionRecord.logger.info('http_session_initialized', {
            cwd: sessionContext.cwd,
            rootUri: sessionContext.rootUri,
            projectRoots: sessionContext.projectRoots,
          });
        },
        onsessionclosed: closedSessionId => (
          this.#cleanupSession(closedSessionId, 'client requested session close')
        ),
        retryInterval: 1000,
      });

      await sessionApp.connect(transport);
      await transport.handleRequest(req, res, req.body);
      if (sessionRecord) this.#touchSession(sessionRecord);
    } catch (error) {
      requestLogger.error('http_post_failed', { error });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }

  async #handleExisting(req: any, res: any): Promise<void> {
    const sessionId = this.#sessionId(req);
    if (!sessionId) {
      res.status(400).send('Missing session ID');
      return;
    }
    const record = this.#sessions.get(sessionId);
    if (!record) {
      res.status(404).send('Unknown session');
      return;
    }
    this.#touchSession(record);
    await record.transport.handleRequest(req, res);
  }

  #sessionId(req: any): string | undefined {
    const raw = req.headers['mcp-session-id'];
    return Array.isArray(raw) ? raw[0] : raw;
  }
}
