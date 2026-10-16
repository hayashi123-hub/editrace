import { packager } from '@electron/packager';
import { readFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const paths = await packager({
  dir: '.',
  out: `release/${version}`,
  name: 'editrace',
  platform: 'win32',
  arch: 'x64',
  asar: true,
  icon: 'assets/icon.ico',
  overwrite: true,
  ignore: [
    /^\/src($|\/)/,
    /^\/tests($|\/)/,
    /^\/scripts($|\/)/,
    /^\/test-results($|\/)/,
    /^\/playwright/,
    /^\/tsconfig/,
    /^\/release($|\/)/,
  ],
  win32metadata: {
    ProductName: 'editrace',
    FileDescription: 'Foreign-language writing practice',
  },
});
console.log(paths.join('\n'));
