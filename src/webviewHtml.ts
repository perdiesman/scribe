import { escapeHtml } from './render';

export function webviewHtml(assets: { style: string; script: string; logo: string; cspSource: string; nonce: string; title: string; connectSource?: string }) {
  const { style, script, logo, cspSource, nonce, title } = assets;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: https: http:; font-src data: ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${assets.connectSource ?? "'none'"}; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${style}"><title>SCRIBE</title></head><body>
<header class="app-header"><div class="brand"><img src="${logo}" alt="SCRIBE logo" width="32" height="32"><div><strong>SCRIBE</strong><span>Write what you see. Commit what you mean.</span></div></div><div id="toolbar" role="toolbar" aria-label="Markdown editing"></div></header>
<main id="workspace" data-mode="wysiwyg"><section id="visual-pane" aria-label="Visual editor pane"><div id="editor" class="markdown-body"></div></section><section id="source-pane" aria-label="Source editor pane" hidden><pre id="source-highlight" class="source-layer" aria-hidden="true"><code></code></pre><textarea id="source" class="source-layer" aria-label="Markdown source" spellcheck="false" wrap="off"></textarea></section><section id="preview-pane" aria-label="Read-only Markdown preview" tabindex="0" hidden></section></main>
<footer id="status" role="status" aria-live="polite">Opening ${escapeHtml(title)}…</footer><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
