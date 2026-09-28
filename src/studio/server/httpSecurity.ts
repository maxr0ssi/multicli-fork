import type {
  StudioAuthManager,
  StudioAuthPrincipal,
} from '../../controlPlane/studioAuth.js';

export type StudioMiddleware = (
  req: any,
  res: any,
  next: (error?: unknown) => void,
) => void;

export function headerValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0] == null ? undefined : String(value[0]);
  return value == null ? undefined : String(value);
}

function originAllowed(origin: string, host: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === host || hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

function requestHostAllowed(authority: string | undefined, host: string): boolean {
  if (!authority || /[@/\\\s?#]/.test(authority)) return false;
  try {
    const parsed = new URL(`http://${authority}`);
    return parsed.hostname === host
      && !parsed.username
      && !parsed.password
      && parsed.pathname === '/';
  } catch {
    return false;
  }
}

export function studioSecurityHeaders(res: any): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

export function studioAuthMiddleware(
  auth: StudioAuthManager,
  host: string,
): StudioMiddleware {
  return (req, res, next) => {
    studioSecurityHeaders(res);
    if (!requestHostAllowed(headerValue(req.headers.host), host)) {
      res.status(403).json({ error: 'Invalid Host header' });
      return;
    }
    const origin = headerValue(req.headers.origin);
    if (origin && !originAllowed(origin, host)) {
      res.status(403).json({ error: 'Invalid Origin header' });
      return;
    }
    const principal = auth.authenticate(
      headerValue(req.headers.authorization),
      headerValue(req.headers.cookie),
    );
    if (!principal) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.multicliPrincipal = principal;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const csrf = headerValue(req.headers['x-multicli-csrf']);
      if (!auth.verifyCsrf(principal, csrf)) {
        res.status(403).json({ error: 'Invalid CSRF token' });
        return;
      }
    }
    next();
  };
}

export function studioPrincipalFrom(req: any): StudioAuthPrincipal {
  return req.multicliPrincipal as StudioAuthPrincipal;
}
