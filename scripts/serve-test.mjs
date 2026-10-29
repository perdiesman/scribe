import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'scribe-ui-'));
const helpers = join(directory, 'markdown.cjs');
await build({ stdin: { contents: "export * from './src/markdown'; export * from './src/protocol'; export * from './src/webviewHtml';", resolveDir: process.cwd(), loader: 'ts' }, outfile: helpers, bundle: true, platform: 'node', format: 'cjs' });
const { preserveMarkdown, normalizeMarkdown, editBases, webviewHtml } = createRequire(import.meta.url)(helpers);
const sessions = new Map();
const snapshot = session => ({ type: 'document', source: session.source, version: session.version, settings: session.settings, isDirty: session.source !== session.savedSource });

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:4178');
    const id = url.searchParams.get('id') ?? 'default';
    let session = sessions.get(id);
    if (!session) { session = { source: '', savedSource: '', version: 1, settings: { autoFormatMarkdown: true, profile: 'github' }, history: [], redo: [], copies: [], recoveries: [], commands: [] }; sessions.set(id, session); }
    const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (url.pathname === '/state') { json(session); return; }
    if (request.method === 'POST') {
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 20_000_000) throw new Error('Request too large'); }
      const message = JSON.parse(body);
      if (url.pathname === '/reset') { session.source = message.source ?? ''; session.savedSource = session.source; session.version++; json(snapshot(session)); return; }
      const messages = [];
      if (message.type === 'ready') { session.chain = undefined; messages.push(snapshot(session)); }
      if (message.type === 'mode') session.mode = message.mode;
      if (message.type === 'edit') {
        const bases = session.mode === 'preview' ? undefined : editBases(message, session.version, session.chain);
        if (bases) {
          const next = message.mode === 'source' ? message.markdown : preserveMarkdown(session.source, message.markdown);
          if (next !== session.source) { session.history.push(session.source); session.redo = []; session.source = next; session.version++; }
          bases.add(session.version); session.chain = { version: session.version, sequence: message.sequence, bases };
          messages.push({ ...snapshot(session), acknowledgment: message.sequence });
        } else messages.push(snapshot(session));
      }
      if (message.type === 'command') session.commands.push(message.command);
      if (message.type === 'command' && message.command === 'save') { session.savedSource = session.source; messages.push({ type: 'saved' }); }
      if (message.type === 'command' && message.command === 'auto') {
        session.settings.autoFormatMarkdown = !session.settings.autoFormatMarkdown;
        messages.push({ type: 'settings', settings: session.settings });
      }
      if (message.type === 'command' && message.command === 'normalize' && session.mode !== 'preview') {
        session.history.push(session.source); session.source = normalizeMarkdown(session.source); session.version++;
        messages.push(snapshot(session));
      }
      if (message.type === 'history' && session.mode !== 'preview') {
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
      response.end(webviewHtml({ style: '/style.css', script: `/editor.js?id=${encodeURIComponent(id)}`, logo: '/logo.png', cspSource: "'self'", connectSource: "'self'", nonce: 'test', title: 'Test document' }));
      return;
    }
    if (url.pathname === '/editor.js') {
      const bridge = `const id=${JSON.stringify(id).replace(/</g, '\\u003c')};let queue=Promise.resolve();window.acquireVsCodeApi=()=>({getState:()=>JSON.parse(sessionStorage.getItem(id)||'null'),setState:state=>sessionStorage.setItem(id,JSON.stringify(state)),postMessage(message){queue=queue.then(()=>fetch('/message?id='+encodeURIComponent(id),{method:'POST',body:JSON.stringify(message)}).then(r=>r.json()).then(messages=>messages.forEach(data=>window.postMessage(data,'*'))))}});`;
      response.setHeader('Content-Type', 'text/javascript'); response.end(bridge + '\n' + await readFile('dist/editor.js', 'utf8')); return;
    }
    const files = { '/editor.js': ['dist/editor.js', 'text/javascript'], '/style.css': ['dist/style.css', 'text/css'], '/render.js': ['dist/render.js', 'text/javascript'], '/logo.png': ['logo.png', 'image/png'] };
    const file = files[url.pathname];
    if (!file) { response.statusCode = 404; response.end(); return; }
    response.setHeader('Content-Type', file[1]); response.end(await readFile(file[0]));
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
server.listen(4178, '127.0.0.1');
process.on('SIGTERM', () => server.close(async () => { await rm(directory, { recursive: true, force: true }); process.exit(); }));
