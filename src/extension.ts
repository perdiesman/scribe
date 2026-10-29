import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { minimalPatch, normalizeMarkdown, preserveMarkdown } from './markdown';
import { validMessage, editBases, type EditChain, type EditorMode, type Settings, type Snapshot } from './protocol';
import { assetRoot, resolveAsset, checkedAsset } from './assets';
import { exportDocument } from './export';
import { webviewHtml } from './webviewHtml';

export function activate(context: vscode.ExtensionContext): void {
  const panels = new Map<vscode.WebviewPanel, vscode.TextDocument>();
  const panelModes = new Map<vscode.WebviewPanel, EditorMode>();
  const queues = new Map<string, Promise<void>>();
  const origins = new Map<string, { panel: vscode.WebviewPanel; sequence: number }>();
  const requestedModes = new Map<string, EditorMode>();
  let lastPanel: vscode.WebviewPanel | undefined;
  const activeReadOnly = () => [...panels.keys()].some(panel => panel.active && panelModes.get(panel) === 'preview');
  const updateReadOnlyContext = () => { void vscode.commands.executeCommand('setContext', 'scribe.readOnly', activeReadOnly()); };
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
    const message: Snapshot = { type: 'document', source, version: document.version, isDirty: document.isDirty, settings: settings(), acknowledgment };
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
  const showMode = async (document: vscode.TextDocument, mode: EditorMode | 'toggle') => {
    const panel = [...panels].find(([panel, doc]) => panel.active && doc.uri.toString() === document.uri.toString())?.[0];
    if (panel) { await panel.webview.postMessage({ type: 'mode', mode }); return; }
    requestedModes.set(document.uri.toString(), mode === 'toggle' ? 'source' : mode);
    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'scribe.editor');
  };
  const commands = {
    source: async (document: vscode.TextDocument) => showMode(document, 'toggle'),
    split: async (document: vscode.TextDocument) => showMode(document, 'split'),
    save: async (document: vscode.TextDocument) => { if (!await document.save()) throw new Error('The document could not be saved.'); },
    auto: async (_document?: vscode.TextDocument) => {
      const config = vscode.workspace.getConfiguration('scribe');
      const target = config.inspect('autoFormatMarkdown')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config.update('autoFormatMarkdown', !settings().autoFormatMarkdown, target);
    },
    normalize: async (document: vscode.TextDocument) => {
      if (activeReadOnly()) return;
      enqueue(document, async () => applyText(document, normalizeMarkdown(document.getText())));
    },
    html: async (document: vscode.TextDocument) => exportDocument(context, document, 'html', settings().profile),
    pdf: async (document: vscode.TextDocument) => exportDocument(context, document, 'pdf', settings().profile),
  };

  context.subscriptions.push(vscode.window.registerCustomEditorProvider('scribe.editor', {
    async resolveCustomTextEditor(document, panel) {
      let chain: EditChain | undefined;
      panels.set(panel, document); lastPanel = panel;
      panel.webview.options = { enableScripts: true, localResourceRoots: [context.extensionUri, assetRoot(document.uri)] };
      const webUri = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, name)).toString();
      const nonce = randomBytes(18).toString('base64');
      panel.webview.html = webviewHtml({ style: webUri('dist/style.css'), script: webUri('dist/editor.js'), logo: webUri('logo.png'), cspSource: panel.webview.cspSource, nonce, title: document.uri.path.split('/').at(-1) ?? 'document' });
      const subscriptions = [
        panel.onDidChangeViewState(() => { if (panel.active) lastPanel = panel; updateReadOnlyContext(); }),
        panel.webview.onDidReceiveMessage(async (value: unknown) => {
          if (!validMessage(value)) return;
          try {
            switch (value.type) {
              case 'mode': panelModes.set(panel, value.mode); updateReadOnlyContext(); break;
              case 'ready': enqueue(document, async () => {
                chain = undefined; snapshot(panel, document);
                const mode = requestedModes.get(document.uri.toString());
                if (mode) { requestedModes.delete(document.uri.toString()); await panel.webview.postMessage({ type: 'mode', mode }); }
              }); break;
              case 'profile': {
                const config = vscode.workspace.getConfiguration('scribe');
                const target = config.inspect('renderingProfile')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
                await config.update('renderingProfile', value.profile, target); break;
              }
              case 'edit': enqueue(document, async () => {
                if (panelModes.get(panel) === 'preview') { snapshot(panel, document); return; }
                const bases = editBases(value, document.version, chain);
                if (!bases) { snapshot(panel, document); return; }
                const key = document.uri.toString();
                origins.set(key, { panel, sequence: value.sequence });
                try {
                  await applyText(document, value.mode === 'source' ? value.markdown : preserveMarkdown(document.getText(), value.markdown));
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
              case 'history': if (panelModes.get(panel) !== 'preview') await vscode.commands.executeCommand(value.direction); break;
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
      panel.onDidDispose(() => { panels.delete(panel); panelModes.delete(panel); updateReadOnlyContext(); subscriptions.forEach(subscription => subscription.dispose()); if (lastPanel === panel) lastPanel = undefined; });
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
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    for (const [panel, doc] of panels) if (doc.uri.toString() === document.uri.toString()) void panel.webview.postMessage({ type: 'saved' });
  }));
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
        await commands[action](document);
      }
    } catch (error) { report(error); }
  }));
}
