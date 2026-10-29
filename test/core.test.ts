import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, symlink, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeMarkdown, preserveMarkdown, minimalPatch, sourceBlocks, parseMarkdown, fencedCode, inlineMarkdownTrigger } from '../src/markdown';
import { validMessage, editBases } from '../src/protocol';
import { renderMarkdown } from '../src/render';
import { projectMarkdown } from '../src/webview/projection';
import { checkedAsset, embeddedImages, resolveAsset } from '../src/assets';
import { Uri, workspaceRoot } from './vscode-stub';
import { exportUI } from './vscode-stub';
import type * as vscode from 'vscode';
import './editor.test';
import { exportDocument } from '../src/export';
import { runInNewContext } from 'node:vm';

test('opening without edits leaves mixed Markdown byte-for-byte unchanged', () => {
  const source = '\r\nTitle\r\n=====\r\n\r\n*   A\r\n*   B\r\n\r\n[link][ref]\r\n\r\n[ref]: https://example.com "Title"\r\n\r\n<!-- keep -->\r\n';
  const serialized = '# Title\n\n- A\n- B\n\n[link](https://example.com "Title")\n\n[ref]: https://example.com "Title"\n\n<!-- keep -->\n';
  assert.equal(preserveMarkdown(source, serialized), source);
});

test('editing one block preserves surrounding source, spacing, and CRLF', () => {
  const source = 'Title\r\n=====\r\n\r\n\r\nOriginal.\r\n\r\n*   Keep\r\n\r\n';
  const result = preserveMarkdown(source, '# Title\n\nEdited.\n\n- Keep\n');
  assert.equal(result, 'Title\r\n=====\r\n\r\nEdited.\r\n\r\n*   Keep\r\n\r\n');
  assert.equal(preserveMarkdown(result, '# Title\n\nEdited.\n\n- Keep\n'), result);
});

test('inserting, deleting, splitting, and merging blocks keeps unaffected content', () => {
  assert.equal(preserveMarkdown('One.\n\nTwo.\n\nThree.', 'One.\n\nNew.\n\nTwo.\n\nThree.\n'), 'One.\n\nNew.\n\nTwo.\n\nThree.');
  assert.equal(preserveMarkdown('One.\n\nTwo.\n\nThree.', 'One.\n\nThree.'), 'One.\n\nThree.');
  assert.equal(preserveMarkdown('One two.\n\n* Keep', 'One\n\ntwo.\n\n- Keep'), 'One\n\ntwo.\n\n* Keep');
  assert.equal(preserveMarkdown('One\n\ntwo.\n\n* Keep', 'One two.\n\n- Keep'), 'One two.\n\n* Keep');
});

test('duplicate blocks retain their order and deleted documents do not resurrect text', () => {
  assert.equal(preserveMarkdown('same\n\n* A\n\nsame\n\n* B\n', 'same\n\n- A\n\nchanged\n\n- B\n'), 'same\n\n* A\n\nchanged\n\n* B\n');
  assert.equal(preserveMarkdown('# Delete\n', ''), '\n');
});

test('front matter and opaque syntax survive projection and normalization', () => {
  for (const source of ['---\r\ntitle: Keep  spaces\r\n---\r\n\r\n# Hello\r\n', '+++\ntitle = "Keep"\n+++\n\nHello\n']) {
    const tree = parseMarkdown(source);
    assert.ok(['yaml', 'toml'].includes(tree.children[0].type));
    const projected = projectMarkdown(source);
    assert.equal(projected.children[0].type as string, 'scribeBlock');
    assert.ok(normalizeMarkdown(source).startsWith(source.slice(0, source.indexOf('# Hello') > 0 ? source.indexOf('# Hello') : source.indexOf('Hello'))));
    assert.equal(normalizeMarkdown(normalizeMarkdown(source)), normalizeMarkdown(source));
  }
  assert.equal(parseMarkdown('---\nnot closed').children[0].type, 'thematicBreak');
  const projected = projectMarkdown('Text $x^2$ and note[^a].\n\n[^a]: Footnote\n\n<!-- preserved -->');
  assert.equal(projected.children.at(-1)!.type as string, 'scribeBlock');
});

test('normalization is deterministic and does not wrap paragraphs', () => {
  const source = 'Heading\n=======\n\n*   A\n*   B\n\n' + 'long '.repeat(40) + '\n';
  const normalized = normalizeMarkdown(source);
  assert.match(normalized, /^# Heading\n\n- A\n- B/);
  assert.ok(normalized.includes('long '.repeat(39) + 'long'));
  assert.equal(normalizeMarkdown(normalized), normalized);
});

test('minimal patches reconstruct source including Unicode and line endings', () => {
  for (const [before, after] of [['a😀z', 'a😃z'], ['abc', ''], ['', 'new'], ['a\r\nb', 'a\r\nB'], ['same', 'same']]) {
    const patch = minimalPatch(before, after);
    assert.equal(patch ? before.slice(0, patch.start) + patch.text + before.slice(patch.end) : before, after);
    if (patch) assert.ok(!/[\uDC00-\uDFFF]/.test(before[patch.start] ?? ''));
  }
});

test('code copying uses fences longer than any code content delimiter', () => {
  const code = '  indented\n```\n\tend\n';
  assert.equal(fencedCode(code, 'ts'), '````ts\n' + code + '\n````');
  assert.equal(fencedCode('', 'js\n<script>'), '```js<script>\n\n```');
});

test('inline conversion waits for complete delimiters instead of prematurely converting bold to italic', () => {
  for (const value of ['**bold*', '__bold_', '***both*', '***both**', '``code`', '$$x$', '~~strike~']) assert.equal(inlineMarkdownTrigger(value), false, value);
  for (const value of ['**bold**', '__bold__', '***both***', 'text *italic*', 'text _italic_', '``code``', '$$x$$', '$x$', '~~strike~~', '[label](https://example.com)']) assert.equal(inlineMarkdownTrigger(value), true, value);
});

test('source blocks have accurate zero-based positions', () => {
  assert.deepEqual(sourceBlocks('# Head\n\nText\n'), [{ start: 0, end: 6, line: 0, endLine: 0 }, { start: 8, end: 12, line: 2, endLine: 2 }]);
});

test('webview boundary rejects unknown and malformed messages', () => {
  for (const message of [null, {}, { type: 'mode', mode: 'invalid' }, { type: 'command', command: 'executeShell' }, { type: 'edit', version: -1, sequence: 1, markdown: '' }, { type: 'edit', version: 1, sequence: 1, markdown: '', mode: 'invalid' }, { type: 'copy', text: 1 }, { type: 'profile', profile: 'evil' }]) assert.equal(validMessage(message), false);
  for (const message of [{ type: 'ready' }, { type: 'mode', mode: 'preview' }, { type: 'mode', mode: 'wysiwyg' }, { type: 'edit', version: 1, sequence: 1, markdown: '# Hi' }, { type: 'edit', version: 1, sequence: 1, markdown: '# Hi', mode: 'source' }, { type: 'command', command: 'save' }, { type: 'command', command: 'auto' }, { type: 'profile', profile: 'gitlab' }]) assert.equal(validMessage(message), true);
});

test('queued edits accept their own version chain and reject concurrent or reordered updates', () => {
  const edit = (version: number, sequence: number) => ({ type: 'edit' as const, version, sequence, markdown: 'text' });
  const first = editBases(edit(1, 1), 1)!; first.add(2);
  const chain = { version: 2, sequence: 1, bases: first };
  assert.ok(editBases(edit(1, 2), 2, chain));
  assert.ok(editBases(edit(2, 2), 2, chain));
  assert.equal(editBases(edit(1, 2), 3, chain), undefined);
  assert.equal(editBases(edit(2, 1), 2, chain), undefined);
  assert.equal(editBases(edit(99, 2), 2, chain), undefined);
  assert.deepEqual(editBases(edit(3, 2), 3, chain), new Set([3]));
});

test('renderer supports tables, tasks, footnotes, math, diagrams, alerts, and details', () => {
  const html = renderMarkdown('| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Done\n\nNote[^a].\n\n[^a]: Footnote\n\n$x^2$\n\n```mermaid\ngraph TD; A-->B\n```\n\n> [!NOTE]\n> Useful\n\n<details><summary>More</summary>Details</details>', 'gitlab');
  for (const value of ['<table>', 'type="checkbox"', 'footnote', 'katex', 'class="mermaid"', 'markdown-alert', '<details>', 'profile-gitlab']) assert.ok(html.includes(value), value);
  for (const [, fragment] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(html.includes(`id="${fragment}"`), `Missing footnote target: ${fragment}`);
});

test('renderer removes executable HTML and dangerous protocols', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n[bad](javascript:alert%281%29)\n\n<iframe src="https://evil.example"></iframe>\n\n<div style="background:url(https://evil.example)">safe</div>');
  for (const value of ['<script', 'onerror', 'javascript:', '<iframe', 'background:url']) assert.equal(html.includes(value), false, value);
  assert.ok(html.includes('safe'));
});

test('front matter is omitted from rendered output; code is escaped and highlighted', () => {
  const html = renderMarkdown('---\nsecret: metadata\n---\n\n```js\nconst x = "<script>";\n```');
  assert.ok(!html.includes('secret: metadata'));
  assert.ok(html.includes('hljs-keyword'));
  assert.ok(!html.includes('<script>'));
});

test('logo, commands, setting, and repository metadata are packaged', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.icon, 'logo.png'); assert.ok(readFileSync(pkg.icon).length > 0);
  assert.ok(pkg.repository.url.endsWith('perdiesman/scribe.git'));
  assert.equal(pkg.contributes.configuration.properties['scribe.autoFormatMarkdown'].default, true);
  assert.equal(pkg.contributes.customEditors[0].priority, 'option');
});

test('local image resolution rejects traversal, protocols, malformed paths, and symlink escapes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scribe-assets-'));
  const root = join(directory, 'workspace'); await mkdir(root);
  workspaceRoot(Uri.file(root));
  const document = Uri.file(join(root, 'readme.md')) as unknown as vscode.Uri;
  try {
    for (const value of ['https://example.com/image.png', '//example.com/image.png', '../../private.png', '%2e%2e/%2e%2e/private.png', 'x%00.png', 'x\\secret.png']) {
      assert.throws(() => resolveAsset(document, value), value);
    }
    await writeFile(join(directory, 'private.png'), 'private');
    await symlink(join(directory, 'private.png'), join(root, 'linked.png'));
    await symlink(directory, join(root, 'linked-directory'));
    await assert.rejects(checkedAsset(document, 'linked.png'), /Linked assets/);
    await assert.rejects(checkedAsset(document, 'linked-directory/private.png'), /Linked assets/);
  } finally { workspaceRoot(); await rm(directory, { recursive: true, force: true }); }
});

test('exports embed local assets and report remote, missing, oversized, or unsupported images', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scribe-embed-'));
  workspaceRoot(Uri.file(directory));
  const document = Uri.file(join(directory, 'readme.md')) as unknown as vscode.Uri;
  try {
    await writeFile(join(directory, 'image.png'), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(directory, 'text.txt'), 'not an image');
    const huge = await open(join(directory, 'huge.png'), 'w'); await huge.truncate(32 * 1024 * 1024 + 1); await huge.close();
    const html = '<img src="image.png"><img src="https://example.com/image.png"><img src="missing.png"><img src="text.txt"><img src="huge.png">';
    const standalone = await embeddedImages(html, document, false);
    assert.ok(standalone.html.includes('src="data:image/png;base64,iVBORw=="'));
    assert.ok(standalone.html.includes('src="https://example.com/image.png"'));
    assert.equal(standalone.warnings.length, 4);
    const pdf = await embeddedImages(html, document, true);
    assert.ok(!pdf.html.includes('src="https://'));
    assert.ok(pdf.warnings.some(warning => warning.includes('32 MB')));
  } finally { workspaceRoot(); await rm(directory, { recursive: true, force: true }); }
});

test('HTML export finishes progress without waiting for its completion toast to be dismissed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scribe-export-'));
  try {
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'dist', 'style.css'), 'body{color:black}');
    await writeFile(join(directory, 'dist', 'render.js'), 'globalThis.scribeReady=Promise.resolve();');
    exportUI.destination = Uri.file(join(directory, 'export.html')); exportUI.notifications.length = 0;
    const context = { extensionUri: Uri.file(directory) } as unknown as vscode.ExtensionContext;
    const document = { uri: Uri.file(join(directory, 'readme.md')), getText: () => '# Unsaved content' } as unknown as vscode.TextDocument;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exportDocument(context, document, 'html', 'github'), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Export waited for notification dismissal')), 2000); })]);
    } finally { clearTimeout(timeout); }
    assert.equal(exportUI.progressActive, false);
    assert.ok(readFileSync(exportUI.destination.path, 'utf8').includes('Unsaved content'));
    assert.ok(exportUI.notifications.some(notification => notification.message.startsWith('Exported HTML:') && !notification.progressActive));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('minified PDF callback runs in an isolated browser scope without extension-host variables', async () => {
  const probe = runInNewContext(readFileSync(process.env.SCRIBE_PDF_PROBE!, 'utf8') + ';ScribePdfProbe.waitForRenderer;');
  const callback = `(${probe.toString()})()`;
  const result = await runInNewContext(callback, { scribeReady: Promise.resolve(), document: { querySelectorAll: () => ({ length: 2 }) }, setTimeout, clearTimeout });
  assert.equal(result, 2);
  await assert.rejects(runInNewContext(callback, { document: {}, setTimeout, clearTimeout }), /renderer did not initialize/);
});
