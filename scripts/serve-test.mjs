import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'scribe-ui-'));
const helpers = join(directory, 'markdown.cjs');
await build({ stdin: { contents: "export * from './src/markdown'; export * from './src/protocol';", resolveDir: process.cwd(), loader: 'ts' }, outfile: helpers, bundle: true, platform: 'node', format: 'cjs' });
const { preserveMarkdown, normalizeMarkdown, editBases } = createRequire(import.meta.url)(helpers);
const sessions = new Map();
const snapshot = session => ({ type: 'document', source: session.source, version: session.version, settings: session.settings });

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:4178');
    const id = url.searchParams.get('id') ?? 'default';
    let session = sessions.get(id);
    if (!session) { session = { source: '', version: 1, settings: { autoFormatMarkdown: true, profile: 'github' }, history: [], redo: [], copies: [], recoveries: [] }; sessions.set(id, session); }
    const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (url.pathname === '/state') { json(session); return; }
    if (request.method === 'POST') {
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 20_000_000) throw new Error('Request too large'); }
      const message = JSON.parse(body);
      if (url.pathname === '/reset') { session.source = message.source ?? ''; session.version++; json(snapshot(session)); return; }
      const messages = [];
      if (message.type === 'ready') { session.chain = undefined; messages.push(snapshot(session)); }
      if (message.type === 'edit') {
        const bases = editBases(message, session.version, session.chain);
        if (bases) {
          const next = preserveMarkdown(session.source, message.markdown);
          if (next !== session.source) { session.history.push(session.source); session.redo = []; session.source = next; session.version++; }
          bases.add(session.version); session.chain = { version: session.version, sequence: message.sequence, bases };
          messages.push({ ...snapshot(session), acknowledgment: message.sequence });
        } else messages.push(snapshot(session));
      }
      if (message.type === 'command' && message.command === 'auto') {
        session.settings.autoFormatMarkdown = !session.settings.autoFormatMarkdown;
        messages.push({ type: 'settings', settings: session.settings });
      }
      if (message.type === 'command' && message.command === 'normalize') {
        session.history.push(session.source); session.source = normalizeMarkdown(session.source); session.version++;
        messages.push(snapshot(session));
      }
      if (message.type === 'history') {
        const from = message.direction === 'undo' ? session.history : session.redo;
        const to = message.direction === 'undo' ? session.redo : session.history;
        if (from.length) { to.push(session.source); session.source = from.pop(); session.version++; messages.push(snapshot(session)); }
      }
      if (message.type === 'profile') { session.settings.profile = message.profile; messages.push({ type: 'settings', settings: session.settings }); }
      if (message.type === 'copy') { session.copies.push(message.text); messages.push({ type: 'status', text: 'Copied to clipboard.' }); }
      if (message.type === 'recover') session.recoveries.push(message.markdown);
      if (message.type === 'asset') messages.push({ type: 'asset', request: message.request, uri: '/logo.png' });
      json(messages); return;
    }
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'nonce-test'; style-src 'self' 'unsafe-inline'; font-src data:; img-src 'self' data:; connect-src 'self'"><link rel="stylesheet" href="/style.css"></head><body><div id="toolbar" role="toolbar" aria-label="Markdown editing"></div><main id="editor" class="markdown-body"></main><footer id="status" role="status"></footer><script nonce="test">const id=${JSON.stringify(id).replace(/</g, '\\u003c')}; window.acquireVsCodeApi=()=>({postMessage(message){fetch('/message?id='+encodeURIComponent(id),{method:'POST',body:JSON.stringify(message)}).then(r=>r.json()).then(messages=>messages.forEach(data=>window.postMessage(data,'*')))}});</script><script src="/editor.js"></script></body></html>`);
      return;
    }
    const files = { '/editor.js': ['dist/editor.js', 'text/javascript'], '/style.css': ['dist/style.css', 'text/css'], '/render.js': ['dist/render.js', 'text/javascript'], '/logo.png': ['logo.png', 'image/png'] };
    const file = files[url.pathname];
    if (!file) { response.statusCode = 404; response.end(); return; }
    response.setHeader('Content-Type', file[1]); response.end(await readFile(file[0]));
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
server.listen(4178, '127.0.0.1');
process.on('SIGTERM', () => server.close(async () => { await rm(directory, { recursive: true, force: true }); process.exit(); }));
