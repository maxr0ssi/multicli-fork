import os from 'node:os';
import path from 'node:path';

export type MultiCliLogLevel = 'error' | 'info' | 'debug';
export type MultiCliStderrLogLevel = MultiCliLogLevel | 'silent';
export type MultiCliTransport = 'stdio' | 'http';

function getDefaultServiceRootDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  switch (platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'MultiCLI');
    case 'win32':
      return path.join(
        env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
        'MultiCLI',
      );
    default:
      return path.join(
        env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
        'multicli',
      );
  }
}

export interface MultiCliConfig {
  transport: MultiCliTransport;
  /** Optional last-resort wall-clock ceiling for direct model calls. */
  askTimeoutMs?: number;
  helpTimeoutMs: number;
  cliDetectTimeoutMs: number;
  killGraceMs: number;
  taskTtlMs: number;
  taskPollIntervalMs: number;
  progressIdleHeartbeatMs: number;
  progressThrottleMs: number;
  httpHost: string;
  httpPort: number;
  httpPath: string;
  httpAuthToken?: string;
  httpSessionIdleMs: number;
  studioSessionTtlMs: number;
  runStorePath: string;
  logPath: string;
  logLevel: MultiCliLogLevel;
  stderrLogLevel: MultiCliStderrLogLevel;
  serviceRootDir: string;
  serviceLogPath: string;
  serviceEnvPath: string;
  serviceManifestPath: string;
}

const DEFAULTS: MultiCliConfig = {
  transport: 'stdio',
  askTimeoutMs: undefined,
  helpTimeoutMs: 2 * 60 * 1000,
  cliDetectTimeoutMs: 30 * 1000,
  killGraceMs: 5 * 1000,
  taskTtlMs: 24 * 60 * 60 * 1000,
  taskPollIntervalMs: 1000,
  progressIdleHeartbeatMs: 10 * 1000,
  progressThrottleMs: 1000,
  httpHost: '127.0.0.1',
  httpPort: 37420,
  httpPath: '/mcp',
  httpAuthToken: undefined,
  httpSessionIdleMs: 24 * 60 * 60 * 1000,
  logPath: path.join(os.homedir(), '.multicli', 'logs', 'multicli.log'),
  studioSessionTtlMs: 8 * 60 * 60 * 1000,
  runStorePath: path.join(os.homedir(), '.multicli', 'studio', 'runs.sqlite'),
  logLevel: 'error',
  stderrLogLevel: 'error',
  serviceRootDir: getDefaultServiceRootDir(),
  serviceLogPath: path.join(getDefaultServiceRootDir(), 'logs', 'service.log'),
  serviceEnvPath: path.join(getDefaultServiceRootDir(), 'env'),
  serviceManifestPath: path.join(getDefaultServiceRootDir(), 'manifest.json'),
};

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseLogLevel(
  value: string | undefined,
  fallback: MultiCliLogLevel,
): MultiCliLogLevel {
  switch (value) {
    case 'error':
    case 'info':
    case 'debug':
      return value;
    default:
      return fallback;
  }
}

function parseTransport(
  value: string | undefined,
  fallback: MultiCliTransport,
): MultiCliTransport {
  switch (value) {
    case 'stdio':
    case 'http':
      return value;
    default:
      return fallback;
  }
}

function parseStderrLogLevel(
  value: string | undefined,
  fallback: MultiCliStderrLogLevel,
): MultiCliStderrLogLevel {
  switch (value) {
    case 'error':
    case 'info':
    case 'debug':
    case 'silent':
      return value;
    default:
      return fallback;
  }
}

function parseString(
  value: string | undefined,
  fallback: string,
): string {
  if (!value) {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeHttpPath(value: string | undefined, fallback: string): string {
  const parsed = parseString(value, fallback);
  return parsed.startsWith('/') ? parsed : `/${parsed}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MultiCliConfig {
  const serviceRootDir = parseString(
    env.MULTICLI_SERVICE_ROOT_DIR,
    DEFAULTS.serviceRootDir,
  );

  return {
    transport: parseTransport(env.MULTICLI_TRANSPORT, DEFAULTS.transport),
    askTimeoutMs: parseOptionalPositiveInt(env.MULTICLI_ASK_TIMEOUT_MS),
    helpTimeoutMs: parsePositiveInt(env.MULTICLI_HELP_TIMEOUT_MS, DEFAULTS.helpTimeoutMs),
    cliDetectTimeoutMs: parsePositiveInt(env.MULTICLI_CLI_DETECT_TIMEOUT_MS, DEFAULTS.cliDetectTimeoutMs),
    killGraceMs: parsePositiveInt(env.MULTICLI_KILL_GRACE_MS, DEFAULTS.killGraceMs),
    taskTtlMs: parsePositiveInt(env.MULTICLI_TASK_TTL_MS, DEFAULTS.taskTtlMs),
    taskPollIntervalMs: parsePositiveInt(env.MULTICLI_TASK_POLL_INTERVAL_MS, DEFAULTS.taskPollIntervalMs),
    progressIdleHeartbeatMs: parsePositiveInt(
      env.MULTICLI_PROGRESS_IDLE_HEARTBEAT_MS,
      DEFAULTS.progressIdleHeartbeatMs,
    ),
    progressThrottleMs: parsePositiveInt(
      env.MULTICLI_PROGRESS_THROTTLE_MS,
      DEFAULTS.progressThrottleMs,
    ),
    httpHost: parseString(env.MULTICLI_HTTP_HOST, DEFAULTS.httpHost),
    httpPort: parsePositiveInt(env.MULTICLI_HTTP_PORT, DEFAULTS.httpPort),
    httpPath: normalizeHttpPath(env.MULTICLI_HTTP_PATH, DEFAULTS.httpPath),
    httpAuthToken: env.MULTICLI_HTTP_AUTH_TOKEN?.trim() || DEFAULTS.httpAuthToken,
    httpSessionIdleMs: parsePositiveInt(
      env.MULTICLI_HTTP_SESSION_IDLE_MS,
      DEFAULTS.httpSessionIdleMs,
    ),
    studioSessionTtlMs: parsePositiveInt(
      env.MULTICLI_STUDIO_SESSION_TTL_MS,
      DEFAULTS.studioSessionTtlMs,
    ),
    runStorePath: parseString(env.MULTICLI_RUN_STORE_PATH, DEFAULTS.runStorePath),
    logPath: parseString(env.MULTICLI_LOG_PATH, DEFAULTS.logPath),
    logLevel: parseLogLevel(env.MULTICLI_LOG_LEVEL, DEFAULTS.logLevel),
    stderrLogLevel: parseStderrLogLevel(
      env.MULTICLI_STDERR_LOG_LEVEL,
      DEFAULTS.stderrLogLevel,
    ),
    serviceRootDir,
    serviceLogPath: parseString(
      env.MULTICLI_SERVICE_LOG_PATH,
      path.join(serviceRootDir, 'logs', 'service.log'),
    ),
    serviceEnvPath: parseString(
      env.MULTICLI_SERVICE_ENV_PATH,
      path.join(serviceRootDir, 'env'),
    ),
    serviceManifestPath: parseString(
      env.MULTICLI_SERVICE_MANIFEST_PATH ?? env.MULTICLI_SERVICE_RUNTIME_PATH,
      path.join(serviceRootDir, 'manifest.json'),
    ),
  };
}
