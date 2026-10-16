import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await Promise.all([
  build({
    entryPoints: ['src/main.ts'],
    outfile: 'dist/main.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    target: 'node22',
  }),
  build({
    entryPoints: ['src/preload.ts'],
    outfile: 'dist/preload.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    target: 'node22',
  }),
  build({
    entryPoints: ['src/renderer.ts'],
    outfile: 'dist/renderer.js',
    bundle: true,
    platform: 'browser',
    target: 'chrome132',
  }),
  copyFile('src/index.html', 'dist/index.html'),
  copyFile('src/styles.css', 'dist/styles.css'),
]);
console.log('Build complete.');
