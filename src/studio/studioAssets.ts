import { fileURLToPath } from 'node:url';

export const STUDIO_ASSETS = {
  'studio.css': {
    contentType: 'text/css; charset=utf-8',
    path: fileURLToPath(new URL('./assets/studio.css', import.meta.url)),
  },
  'studio.js': {
    contentType: 'text/javascript; charset=utf-8',
    path: fileURLToPath(new URL('./assets/studio.js', import.meta.url)),
  },
  'studio.js.map': {
    contentType: 'application/json; charset=utf-8',
    path: fileURLToPath(new URL('./assets/studio.js.map', import.meta.url)),
  },
} as const;

export type StudioAssetName = keyof typeof STUDIO_ASSETS;

export function studioAsset(name: string) {
  return Object.prototype.hasOwnProperty.call(STUDIO_ASSETS, name)
    ? STUDIO_ASSETS[name as StudioAssetName]
    : undefined;
}
