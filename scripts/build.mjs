import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
await mkdir(dist, { recursive: true });
const shared = { bundle: true, logLevel: 'info', sourcemap: false, target: 'es2022', legalComments: 'eof', minify: true };
await Promise.all([
  build({ ...shared, entryPoints: [resolve(root, 'src/extension.ts')], outfile: resolve(dist, 'extension.cjs'), platform: 'node', format: 'cjs', external: ['vscode'] }),
  build({ ...shared, entryPoints: [resolve(root, 'src/webview/editor.ts')], outfile: resolve(dist, 'editor.js'), platform: 'browser', format: 'iife' }),
  build({ ...shared, entryPoints: [resolve(root, 'src/webview/enhance.ts')], outfile: resolve(dist, 'render.js'), platform: 'browser', format: 'iife' }),
]);
const styles = await build({ ...shared, entryPoints: [resolve(root, 'src/webview/style.css')], bundle: true, write: false });
const katexPath = require.resolve('katex/dist/katex.min.css');
let katex = await readFile(katexPath, 'utf8');
for (const match of [...katex.matchAll(/url\(([^)]+)\)/g)]) {
  const file = match[1].replace(/["']/g, '');
  const content = await readFile(resolve(dirname(katexPath), file));
  const extension = extname(file).slice(1);
  katex = katex.replace(match[0], `url(data:font/${extension === 'ttf' ? 'ttf' : extension};base64,${content.toString('base64')})`);
}
await writeFile(resolve(dist, 'style.css'), styles.outputFiles[0].text + '\n' + katex);
console.log('SCRIBE extension, editor, standalone renderer, and embedded fonts built.');
