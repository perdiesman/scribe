import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import puppeteer, { PUPPETEER_REVISIONS } from 'puppeteer-core';
import { install, computeExecutablePath, Browser } from '@puppeteer/browsers';
import { embeddedImages } from './assets';
import { renderMarkdown, escapeHtml } from './render';
import type { Profile } from './protocol';

let installing: Promise<string> | undefined;

function waitForDownload(download: Promise<string>, token: vscode.CancellationToken): Promise<string> {
  return new Promise((resolve, reject) => {
    const cancellation = token.onCancellationRequested(() => { cancellation.dispose(); reject(new vscode.CancellationError()); });
    download.then(value => { cancellation.dispose(); token.isCancellationRequested ? reject(new vscode.CancellationError()) : resolve(value); }, error => { cancellation.dispose(); reject(error); });
    if (token.isCancellationRequested) { cancellation.dispose(); reject(new vscode.CancellationError()); }
  });
}

async function chromium(context: vscode.ExtensionContext, token: vscode.CancellationToken, report: (text: string) => void): Promise<string> {
  const cacheDir = join(context.globalStorageUri.fsPath, 'browsers');
  const buildId = PUPPETEER_REVISIONS.chrome;
  const options = { browser: Browser.CHROME, buildId, cacheDir };
  const executable = computeExecutablePath(options);
  if (existsSync(executable)) return executable;
  if (installing) return waitForDownload(installing, token);
  const choice = await vscode.window.showInformationMessage(
    'PDF export needs a one-time Chromium download (several hundred MB). It stays on this computer and works offline afterward.',
    { modal: true }, 'Download Renderer');
  if (choice !== 'Download Renderer' || token.isCancellationRequested) throw new vscode.CancellationError();
  if (installing) return waitForDownload(installing, token);
  const download = (async () => {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    const installed = await install({ ...options, downloadProgressCallback: (downloaded, total) => {
      if (!token.isCancellationRequested) report(`Downloading PDF renderer: ${total ? Math.round(downloaded / total * 100) + '%' : Math.round(downloaded / 1048576) + ' MB'}`);
    } });
    return installed.executablePath;
  })();
  // shortcut: cancelling export lets an active cache download finish; use abort when the installer supports it.
  installing = download;
  const settled = () => { if (installing === download) installing = undefined; };
  void download.then(settled, settled);
  return waitForDownload(download, token);
}

export async function exportDocument(context: vscode.ExtensionContext, document: vscode.TextDocument, format: 'html' | 'pdf', profile: Profile): Promise<void> {
  if (format === 'pdf' && !vscode.workspace.isTrusted) {
    throw new Error('Trust this workspace before downloading or launching the PDF renderer.');
  }
  const destination = await vscode.window.showSaveDialog({
    defaultUri: document.uri.with({ path: document.uri.path.replace(/\.(?:md|markdown)$/i, '') + '.' + format }),
    filters: format === 'pdf' ? { PDF: ['pdf'] } : { HTML: ['html'] },
    title: `Export ${format.toUpperCase()}`,
  });
  if (!destination) return;
  if (destination.toString() === document.uri.toString()) throw new Error('Choose a different file so the Markdown source is preserved.');
  // Capture unsaved text before any asynchronous asset work or renderer installation.
  const source = document.getText();
  const title = document.uri.path.split('/').at(-1) ?? 'SCRIBE document';
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `SCRIBE: Export ${format.toUpperCase()}`, cancellable: true }, async (progress, token) => {
    const check = () => { if (token.isCancellationRequested) throw new vscode.CancellationError(); };
    const asset = (name: string) => vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'dist', name)).then(bytes => Buffer.from(bytes).toString());
    const [{ html: body, warnings }, css, rawScript] = await Promise.all([
      embeddedImages(renderMarkdown(source, profile), document.uri, format === 'pdf'), asset('style.css'), asset('render.js'),
    ]);
    check();
    const script = rawScript.replace(/<\/script/gi, '<\\/script');
    const hash = createHash('sha256').update(script).digest('base64');
    const csp = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data:; base-uri 'none'; form-action 'none'`;
    const html = `<!doctype html><html lang="en" data-scribe-export="true"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${escapeHtml(title)}</title><style>${css}</style></head><body class="export">${body}<script>${script}</script></body></html>`;
    let bytes: Uint8Array;
    if (format === 'html') bytes = Buffer.from(html);
    else {
      const executablePath = await chromium(context, token, message => progress.report({ message }));
      check();
      progress.report({ message: 'Rendering PDF…' });
      const browser = await puppeteer.launch({ executablePath, headless: true, timeout: 30_000 });
      const cancellation = token.onCancellationRequested(() => { void browser.close().catch(() => {}); });
      try {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', request => { void (/^(?:data:|about:)/i.test(request.url()) ? request.continue() : request.abort()); });
        await page.emulateMediaType('print');
        await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
        const diagramErrors = await page.evaluate(async () => {
          const ready = (window as unknown as { scribeReady?: Promise<void> }).scribeReady;
          if (!ready) throw new Error('The document renderer did not initialize.');
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([ready, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Document rendering timed out.')), 30_000); })]);
          } finally { clearTimeout(timeout); }
          return document.querySelectorAll('.render-error').length;
        });
        if (diagramErrors) warnings.push(`${diagramErrors} Mermaid diagram(s) could not render; their source is included.`);
        check();
        bytes = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' }, timeout: 30_000 });
      } catch (error) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        throw error;
      } finally { cancellation.dispose(); await browser.close(); }
    }
    check();
    await vscode.workspace.fs.writeFile(destination, bytes);
    if (warnings.length) {
      const details = await vscode.window.showWarningMessage(`Exported ${format.toUpperCase()} with ${warnings.length} image warning(s).`, 'Show Details');
      if (details) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: warnings.join('\n'), language: 'plaintext' }));
    } else await vscode.window.showInformationMessage(`Exported ${format.toUpperCase()}: ${destination.path.split('/').at(-1)}`);
  });
}
