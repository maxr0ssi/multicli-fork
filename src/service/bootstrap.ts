import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function loadServiceEnvironment(
  envFilePath: string,
  targetEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const raw = readFileSync(envFilePath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`Service environment value for ${key} must be a string.`);
    }
    targetEnv[key] = value;
  }

  return targetEnv;
}

export async function runServiceBootstrap(argv = process.argv.slice(2)): Promise<void> {
  const [envFilePath, entrypointPath, ...entrypointArgs] = argv;

  if (!envFilePath || !entrypointPath) {
    throw new Error('Usage: bootstrap <env-file> <entrypoint> [args...]');
  }

  loadServiceEnvironment(envFilePath);
  process.argv = [process.execPath, entrypointPath, ...entrypointArgs];
  await import(pathToFileURL(entrypointPath).href);
}

const isMainModule = process.argv[1]
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMainModule) {
  void runServiceBootstrap().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
