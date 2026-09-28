export type ServiceKind = 'launchd' | 'systemd-user' | 'windows-task';

export interface ServicePaths {
  root: string;
  manifest: string;
  envFile: string;
  launcher: string;
  serviceDefinition: string;
  logFile: string;
  stderrLogFile: string;
}

export interface ServiceManifest {
  schemaVersion: 1;
  label: string;
  platform: NodeJS.Platform;
  serviceKind: ServiceKind;
  installedAt: string;
  runtime: {
    nodePath: string;
    bootstrapPath: string;
    entrypointPath: string;
    packageVersion: string;
  };
  transport: {
    host: string;
    port: number;
    path: string;
    token: string;
    url: string;
    healthUrl: string;
  };
  paths: ServicePaths;
}
