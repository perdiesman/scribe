import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { minimalPatch, normalizeMarkdown, preserveMarkdown, sourceBlocks } from './markdown';
import { validMessage, editBases, type EditChain, type Settings, type Snapshot } from './protocol';
import { assetRoot, resolveAsset, checkedAsset } from './assets';
import { exportDocument } from './export';
import { escapeHtml } from './render';

export function activate(context: vscode.ExtensionContext): void {
  const panels = new Map<vscode.WebviewPanel, vscode.TextDocument>();
  const queues = new Map<string, Promise<void>>();
  const origins = new Map<string, { panel: vscode.WebviewPanel; sequence: number }>();
  let lastPanel: vscode.WebviewPanel | undefined;
  let synchronizing = false;
  const settings = (): Settings => {
    const config = vscode.workspace.getConfiguration('scribe');
    return { autoFormatMarkdown: config.get('autoFormatMarkdown', true) === true,
      profile: config.get('renderingProfile') === 'gitlab' ? 'gitlab' : 'github' };
  };
  const activeDocument = () => {
    const active = [...panels].find(([panel]) => panel.active)?.[1];
    return active ?? vscode.window.activeTextEditor?.document ?? (lastPanel ? panels.get(lastPanel) : undefined);
  };
  const snapshot = (panel: vscode.WebviewPanel, document: vscode.TextDocument, acknowledgment?: number) => {
    const source = document.getText();
    const message: Snapshot = { type: 'document', source, version: document.version, settings: settings(), acknowledgment };
    void panel.webview.postMessage(message);
  };
  const report = (error: unknown) => {
    if (!(error instanceof vscode.CancellationError)) void vscode.window.showErrorMessage(`SCRIBE: ${error instanceof Error ? error.message : String(error)}`);
  };
  const recover = async (markdown: string, reason: string) => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' }), { viewColumn: vscode.ViewColumn.Beside });
    await vscode.window.showWarningMessage(`SCRIBE preserved your pending visual edits in an untitled Markdown document. ${reason}`);
  };
  const enqueue = (document: vscode.TextDocument, work: () => Promise<void>) => {
    const key = document.uri.toString();
    const next = (queues.get(key) ?? Promise.resolve()).then(work).catch(report);
    queues.set(key, next);
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  };
  const applyText = async (document: vscode.TextDocument, text: string) => {
    const patch = minimalPatch(document.getText(), text);
    if (!patch) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(patch.start), document.positionAt(patch.end)), patch.text);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('The document edit could not be applied.');
  };
  const source = async (document: vscode.TextDocument, beside = false) => {
    if (beside) await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
    else await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
  };
  const commands = {
    source: async (document: vscode.TextDocument) => source(document),
    split: async (document: vscode.TextDocument) => source(document, true),
    auto: async (_document?: vscode.TextDocument) => {
      const config = vscode.workspace.getConfiguration('scribe');
      const target = config.inspect('autoFormatMarkdown')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config.update('autoFormatMarkdown', !settings().autoFormatMarkdown, target);
    },
    normalize: async (document: vscode.TextDocument) => {
      enqueue(document, async () => applyText(document, normalizeMarkdown(document.getText())));
    },
    html: async (document: vscode.TextDocument) => exportDocument(context, document, 'html', settings().profile),
    pdf: async (document: vscode.TextDocument) => exportDocument(context, document, 'pdf', settings().profile),
  };

  context.subscriptions.push(vscode.window.registerCustomEditorProvider('scribe.editor', {
    async resolveCustomTextEditor(document, panel) {
      let chain: EditChain | undefined;
      panels.set(panel, document); lastPanel = panel;
      panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), assetRoot(document.uri), vscode.Uri.joinPath(context.extensionUri, 'logo.png')] };
      const webUri = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, name)).toString();
      const nonce = randomBytes(18).toString('base64');
      panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data: https: http:; font-src data: ${panel.webview.cspSource}; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${webUri('dist/style.css')}"><title>SCRIBE</title></head><body><header class="brand"><img src="${webUri('logo.png')}" alt="" width="36" height="36"><div><strong>SCRIBE</strong><span>Write what you see. Commit what you mean.</span></div></header><div id="toolbar" role="toolbar" aria-label="Markdown editing"></div><main id="editor" class="markdown-body" aria-label="Visual Markdown editor"></main><footer id="status" role="status" aria-live="polite">Opening ${escapeHtml(document.uri.path.split('/').at(-1) ?? 'document')}…</footer><script nonce="${nonce}" src="${webUri('dist/editor.js')}"></script></body></html>`;
      const subscriptions = [
        panel.onDidChangeViewState(() => { if (panel.active) lastPanel = panel; }),
        panel.webview.onDidReceiveMessage(async (value: unknown) => {
          if (!validMessage(value)) return;
          try {
            switch (value.type) {
              case 'ready': enqueue(document, async () => { chain = undefined; snapshot(panel, document); }); break;
              case 'profile': {
                const config = vscode.workspace.getConfiguration('scribe');
                const target = config.inspect('renderingProfile')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
                await config.update('renderingProfile', value.profile, target); break;
              }
              case 'edit': enqueue(document, async () => {
                const bases = editBases(value, document.version, chain);
                if (!bases) { snapshot(panel, document); return; }
                const key = document.uri.toString();
                origins.set(key, { panel, sequence: value.sequence });
                try {
                  await applyText(document, preserveMarkdown(document.getText(), value.markdown));
                  bases.add(document.version); chain = { version: document.version, sequence: value.sequence, bases };
                  snapshot(panel, document, value.sequence);
                } catch (error) {
                  await recover(value.markdown, `The source could not be updated: ${error instanceof Error ? error.message : String(error)}`);
                  snapshot(panel, document);
                } finally { origins.delete(key); }
              }); break;
              case 'command': await commands[value.command](document); break;
              case 'copy':
                await vscode.env.clipboard.writeText(value.text);
                void panel.webview.postMessage({ type: 'status', text: 'Copied to clipboard.' }); break;
              case 'recover':
                await recover(value.markdown, 'The source changed concurrently.'); break;
              case 'history': await vscode.commands.executeCommand(value.direction); break;
              case 'reveal': {
                if (synchronizing) break;
                const editors = vscode.window.visibleTextEditors.filter(editor => editor.document.uri.toString() === document.uri.toString());
                if (!editors.length) break;
                const block = sourceBlocks(document.getText())[value.block];
                if (!block) break;
                synchronizing = true;
                try {
                  for (const editor of editors) {
                    if (value.select !== false) editor.selection = new vscode.Selection(block.line, 0, block.line, 0);
                    editor.revealRange(new vscode.Range(block.line, 0, block.endLine, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                  }
                } finally { setTimeout(() => { synchronizing = false; }, 100); }
                break;
              }
              case 'link': {
                if (/^https?:\/\//i.test(value.href) || /^mailto:/i.test(value.href)) await vscode.env.openExternal(vscode.Uri.parse(value.href));
                else if (!value.href.startsWith('#')) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(resolveAsset(document.uri, value.href)));
                break;
              }
              case 'asset':
                try {
                  const uri = await checkedAsset(document.uri, value.path);
                  void panel.webview.postMessage({ type: 'asset', request: value.request, uri: panel.webview.asWebviewUri(uri).toString() });
                } catch (error) { void panel.webview.postMessage({ type: 'asset', request: value.request, error: String(error) }); }
                break;
            }
          } catch (error) { report(error); snapshot(panel, document); }
        }),
      ];
      panel.onDidDispose(() => { panels.delete(panel); subscriptions.forEach(subscription => subscription.dispose()); if (lastPanel === panel) lastPanel = undefined; });
    },
  }, { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (!event.contentChanges.length) return;
    const origin = origins.get(event.document.uri.toString());
    for (const [panel, document] of panels) if (document.uri.toString() === event.document.uri.toString() && panel !== origin?.panel) snapshot(panel, event.document);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('scribe')) for (const panel of panels.keys()) void panel.webview.postMessage({ type: 'settings', settings: settings() });
  }));
  const reveal = (editor: vscode.TextEditor, line: number, select: boolean) => {
    if (synchronizing || ![...panels.values()].some(document => document.uri.toString() === editor.document.uri.toString())) return;
    const blocks = sourceBlocks(editor.document.getText());
    let block = blocks.findIndex(block => line <= block.endLine);
    if (block < 0) block = Math.max(0, blocks.length - 1);
    for (const [panel, document] of panels) if (document.uri.toString() === editor.document.uri.toString()) void panel.webview.postMessage({ type: 'reveal', block, select });
  };
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => reveal(event.textEditor, event.selections[0].active.line, true)),
    vscode.window.onDidChangeTextEditorVisibleRanges(event => { const line = event.visibleRanges[0]?.start.line; if (line !== undefined) reveal(event.textEditor, line, false); }));
  context.subscriptions.push(vscode.commands.registerCommand('scribe.open', async (uri?: vscode.Uri) => {
    const target = uri ?? activeDocument()?.uri;
    if (target) await vscode.commands.executeCommand('vscode.openWith', target, 'scribe.editor');
  }));
  const ids = { toggleSource: 'source', openSourceBeside: 'split', toggleAutoMarkdown: 'auto', normalize: 'normalize', exportHtml: 'html', exportPdf: 'pdf' } as const;
  for (const [id, action] of Object.entries(ids)) context.subscriptions.push(vscode.commands.registerCommand(`scribe.${id}`, async () => {
    try {
      const document = activeDocument();
      if (action === 'auto') await commands.auto();
      else if (document) {
        await queues.get(document.uri.toString());
        if (action === 'source' && ![...panels.keys()].some(panel => panel.active)) await vscode.commands.executeCommand('vscode.openWith', document.uri, 'scribe.editor');
        else await commands[action](document);
      }
    } catch (error) { report(error); }
  }));
}
