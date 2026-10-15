import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/_relay', { recursive: true });
await Promise.all([
  build({ entryPoints: ['web/app.ts'], outfile: 'dist/_relay/app.js', bundle: true, minify: true, target: 'es2022' }),
  copyFile('web/index.html', 'dist/_relay/index.html'),
  copyFile('web/style.css', 'dist/_relay/style.css'),
  copyFile('web/icon.svg', 'dist/_relay/icon.svg')
]);
console.log('Built management assets in dist/_relay');
