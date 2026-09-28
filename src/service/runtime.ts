import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MultiCliConfig } from '../config.js';
import type { ServiceManifest, ServicePaths } from './types.js';
import { SERVICE_LABEL, WINDOWS_TASK_NAME, getServiceKind, getServicePaths } from './paths.js';

const MANAGED_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'VERTEXAI_LOCATION',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
] as const;

function isTransientRuntimePath(targetPath: string): boolean {
  return targetPath.includes(`${path.sep}_npx${path.sep}`)
    || targetPath.includes(`${path.sep}npm${path.sep}_npx${path.sep}`);
}

export function resolveEntrypointPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, '..', 'index.js'),
    path.resolve(moduleDir, '..', '..', 'dist', 'index.js'),
  ];

  const existingCandidate = candidates.find((candidate) => existsSync(candidate));
  if (!existingCandidate) {
    throw new Error(`Unable to locate a runnable Multi-CLI entrypoint. Tried: ${candidates.join(', ')}`);
  }

  return existingCandidate;
}

export function resolveBootstrapPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, '..', '..', 'dist', 'service', 'bootstrap.js'),
    path.resolve(moduleDir, 'bootstrap.js'),
    path.resolve(moduleDir, 'bootstrap.ts'),
  ];

  const existingCandidate = candidates.find((candidate) => existsSync(candidate));
  if (!existingCandidate) {
    throw new Error(`Unable to locate the Multi-CLI service bootstrap. Tried: ${candidates.join(', ')}`);
  }

  return existingCandidate;
}

export function resolveServiceRuntime(): {
  nodePath: string;
  bootstrapPath: string;
  entrypointPath: string;
  packageVersion: string;
} {
  const nodePath = process.execPath;
  const bootstrapPath = resolveBootstrapPath();
  const entrypointPath = resolveEntrypointPath();

  if (isTransientRuntimePath(nodePath) || isTransientRuntimePath(bootstrapPath) || isTransientRuntimePath(entrypointPath)) {
    throw new Error(
      'Service install cannot use a transient npx runtime. Install Multi-CLI globally or run it from a stable local checkout first.',
    );
  }

  if (!existsSync(nodePath)) {
    throw new Error(`Node runtime does not exist: ${nodePath}`);
  }

  if (!existsSync(bootstrapPath)) {
    throw new Error(`Bootstrap entrypoint does not exist: ${bootstrapPath}`);
  }

  if (!existsSync(entrypointPath)) {
    throw new Error(`Entrypoint does not exist: ${entrypointPath}`);
  }

  return {
    nodePath,
    bootstrapPath,
    entrypointPath,
    packageVersion: process.env.npm_package_version || 'unknown',
  };
}

export function generateServiceToken(): string {
  return randomBytes(32).toString('hex');
}

export function buildServiceEnvFileContents(
  manifest: ServiceManifest,
  currentEnv: NodeJS.ProcessEnv = process.env,
): string {
  const managedEntries: Record<string, string> = {
    MULTICLI_TRANSPORT: 'http',
    MULTICLI_HTTP_HOST: manifest.transport.host,
    MULTICLI_HTTP_PORT: String(manifest.transport.port),
    MULTICLI_HTTP_PATH: manifest.transport.path,
    MULTICLI_HTTP_AUTH_TOKEN: manifest.transport.token,
    MULTICLI_LOG_PATH: manifest.paths.logFile,
    MULTICLI_SERVICE_ROOT_DIR: manifest.paths.root,
    MULTICLI_SERVICE_LOG_PATH: manifest.paths.logFile,
    MULTICLI_SERVICE_ENV_PATH: manifest.paths.envFile,
    MULTICLI_SERVICE_MANIFEST_PATH: manifest.paths.manifest,
  };

  const envEntries: Record<string, string> = {};

  const currentPath = currentEnv.PATH ?? '';
  if (currentPath) {
    envEntries.PATH = currentPath;
  }

  for (const key of MANAGED_ENV_KEYS) {
    if (key === 'PATH') {
      continue;
    }
    const value = currentEnv[key];
    if (value) {
      envEntries[key] = value;
    }
  }

  return `${JSON.stringify({ ...envEntries, ...managedEntries }, null, 2)}\n`;
}

export function createServiceManifest(
  config: MultiCliConfig,
  token: string,
  platform: NodeJS.Platform = process.platform,
): ServiceManifest {
  const serviceKind = getServiceKind(platform);
  const paths: ServicePaths = getServicePaths(config, platform, process.env);
  const runtime = resolveServiceRuntime();
  const url = `http://${config.httpHost}:${config.httpPort}${config.httpPath}`;

  return {
    schemaVersion: 1,
    label: platform === 'win32' ? WINDOWS_TASK_NAME : SERVICE_LABEL,
    platform,
    serviceKind,
    installedAt: new Date().toISOString(),
    runtime,
    transport: {
      host: config.httpHost,
      port: config.httpPort,
      path: config.httpPath,
      token,
      url,
      healthUrl: `http://${config.httpHost}:${config.httpPort}/health`,
    },
    paths,
  };
}
