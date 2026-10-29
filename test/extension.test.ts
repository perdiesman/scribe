import * as vscode from 'vscode';
import assert from 'node:assert/strict';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for the VS Code editor'); await new Promise(resolve => setTimeout(resolve, 25)); }
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('scribe.scribe-markdown-editor');
  assert.ok(extension); await extension.activate();
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'roundtrip.md');
  const original = 'Title\n=====\n\n*   Keep\n\nEdit here.\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(original));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('scribe.open');
  await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
  assert.equal(document.getText(), original);
  const tabsBefore = vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.length, 0);
  await vscode.commands.executeCommand('scribe.openSourceBeside');
  assert.equal(vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.length, 0), tabsBefore);
  assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
  await vscode.commands.executeCommand('scribe.toggleSource');
  assert.equal(vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.length, 0), tabsBefore);
  assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString())));
  await vscode.commands.executeCommand('scribe.normalize');
  await until(() => document.getText().startsWith('# Title'));
  assert.ok(document.isDirty);
  await vscode.commands.executeCommand('undo');
  await until(() => document.getText() === original);
  const editor = await vscode.window.showTextDocument(document);
  await editor.edit(edit => edit.insert(new vscode.Position(document.lineCount, 0), '\nUnsaved'));
  assert.ok(document.isDirty);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await until(() => document.getText() === original);
  const config = vscode.workspace.getConfiguration('scribe'), initial = config.inspect<boolean>('autoFormatMarkdown')?.globalValue;
  const initialWorkspace = config.inspect<boolean>('autoFormatMarkdown')?.workspaceValue;
  const before = config.get('autoFormatMarkdown', true);
  try {
    await vscode.commands.executeCommand('scribe.toggleAutoMarkdown');
    assert.equal(vscode.workspace.getConfiguration('scribe').get('autoFormatMarkdown'), !before);
    await config.update('autoFormatMarkdown', true, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('scribe.toggleAutoMarkdown');
    assert.equal(vscode.workspace.getConfiguration('scribe').get('autoFormatMarkdown'), false);
  } finally {
    await config.update('autoFormatMarkdown', initial, vscode.ConfigurationTarget.Global);
    await config.update('autoFormatMarkdown', initialWorkspace, vscode.ConfigurationTarget.Workspace);
  }
  console.log('SCRIBE VS Code smoke tests passed: editor registration, shared source, normalization, undo, revert, settings.');
}
