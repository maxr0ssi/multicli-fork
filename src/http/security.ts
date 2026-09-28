import { timingSafeEqual } from 'node:crypto';

import type { MultiCliConfig } from '../config.js';
import type { Logger } from '../logger.js';

export type HttpMiddleware = (req: any, res: any, next: any) => void;

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost';
}

export function validateHttpConfig(config: MultiCliConfig): void {
  if (!isLoopbackHost(config.httpHost)) {
    throw new Error(
      `HTTP host must be loopback-only. Received "${config.httpHost}".`,
    );
  }
  if (!config.httpPath.startsWith('/')) {
    throw new Error(`HTTP path must start with "/". Received "${config.httpPath}".`);
  }
  if (!config.httpAuthToken?.trim()) {
    throw new Error(
      'HTTP auth token is required in HTTP mode. Set MULTICLI_HTTP_AUTH_TOKEN or install the managed service first.',
    );
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createOriginValidationMiddleware(
  logger: Logger,
  host: string,
): HttpMiddleware {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }

    try {
      const url = new URL(origin);
      if (
        url.hostname === host
        || url.hostname === '127.0.0.1'
        || url.hostname === 'localhost'
      ) {
        next();
        return;
      }
    } catch (error) {
      logger.error('http_origin_invalid', { origin, error });
    }

    logger.error('http_origin_rejected', { origin, host });
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid Origin header' },
      id: null,
    });
  };
}

export function createAuthMiddleware(
  logger: Logger,
  token: string,
): HttpMiddleware {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      logger.error('http_auth_missing', {
        method: req.method,
        path: req.path,
      });
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing Authorization header' },
        id: null,
      });
      return;
    }

    const providedToken = header.slice('Bearer '.length);
    if (!safeEqual(providedToken, token)) {
      logger.error('http_auth_rejected', {
        method: req.method,
        path: req.path,
      });
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid Authorization header' },
        id: null,
      });
      return;
    }

    next();
  };
}
