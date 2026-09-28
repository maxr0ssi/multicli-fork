import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';

const outputDirectory = path.resolve('dist/studio/assets');
await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: ['src/studio/client/main.tsx'],
  bundle: true,
  format: 'esm',
  minify: true,
  outfile: path.join(outputDirectory, 'studio.js'),
  platform: 'browser',
  sourcemap: true,
  target: ['es2022'],
});

await build({
  entryPoints: ['src/studio/client/styles/index.css'],
  bundle: true,
  minify: true,
  outfile: path.join(outputDirectory, 'studio.css'),
});
