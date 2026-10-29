import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { splitBlock } from '@milkdown/kit/prose/commands';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Ctx } from '@milkdown/kit/ctx';
import { autoMarkdown } from '../src/webview/auto';
import { formatSource } from '../src/webview/source';
import { highlightMarkdownSource } from '../src/webview/sourceHighlight';

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' },
  paragraph: { group: 'block', content: 'inline*' },
  heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
  code_block: { group: 'block', content: 'text*', marks: '', code: true },
} });
const ctx = { get: () => (text: string) => schema.node('doc', null, schema.node('paragraph', null, schema.text(text))) } as unknown as Ctx;
function viewFor(doc: ReturnType<typeof schema.node>, position: number) {
  const view = { state: EditorState.create({ doc, selection: TextSelection.create(doc, position) }), composing: false,
    dispatch: (transaction: Parameters<EditorView['dispatch']>[0]) => { view.state = view.state.apply(transaction); },
  };
  return view as unknown as EditorView;
}
function key(key: string, extra = {}) { return { key, preventDefault() {}, ...extra } as unknown as KeyboardEvent; }

test('Enter keeps each existing heading and starts the next paragraph', () => {
  for (let level = 1; level <= 6; level++) {
    const heading = schema.node('heading', { level }, schema.text('Title'));
    const view = viewFor(schema.node('doc', null, heading), 6);
    const plugin = autoMarkdown(ctx, () => true, () => {});
    assert.equal(plugin.props.handleKeyDown!.call(plugin, view, key('Enter')), false);
    assert.ok(splitBlock(view.state, view.dispatch));
    assert.equal(view.state.doc.firstChild!.type.name, 'heading');
    assert.equal(view.state.doc.firstChild!.attrs.level, level);
    assert.equal(view.state.doc.firstChild!.textContent, 'Title');
    assert.equal(view.state.selection.$from.parent.type.name, 'paragraph');
  }
});

test('code exit works with Down Arrow, Ctrl+Enter, and Cmd+Enter even with Auto Markdown off', () => {
  for (const event of [key('ArrowDown'), key('Enter', { ctrlKey: true }), key('Enter', { metaKey: true })]) {
    const code = schema.node('code_block', null, schema.text('code'));
    const view = viewFor(schema.node('doc', null, code), 5);
    const plugin = autoMarkdown(ctx, () => false, () => {});
    assert.equal(plugin.props.handleKeyDown!.call(plugin, view, event), true);
    assert.equal(view.state.doc.firstChild!.textContent, 'code');
    assert.equal(view.state.selection.$from.parent.type.name, 'paragraph');
    assert.equal(view.state.doc.childCount, 2);
  }
});

test('Down Arrow reuses the clickable trailing paragraph and normal Enter keeps code literal', () => {
  const code = schema.node('code_block', null, schema.text('code'));
  const view = viewFor(schema.node('doc', null, [code, schema.node('paragraph')]), 5);
  const plugin = autoMarkdown(ctx, () => true, () => {});
  assert.equal(plugin.props.handleKeyDown!.call(plugin, view, key('Enter')), false);
  assert.equal(view.state.doc.childCount, 2);
  assert.equal(plugin.props.handleKeyDown!.call(plugin, view, key('ArrowDown')), true);
  assert.equal(view.state.doc.childCount, 2);
  assert.equal(view.state.selection.$from.parent.type.name, 'paragraph');
});

test('source formatting toggles selected inline syntax without rendering it', () => {
  for (const [action, marker] of [['strong', '**'], ['emphasis', '*'], ['strike', '~~'], ['inlineCode', '`']] as const) {
    const edit = formatSource('Hello world', 6, 11, action);
    const formatted = 'Hello world'.slice(0, edit.from) + edit.text + 'Hello world'.slice(edit.to);
    assert.equal(formatted, `Hello ${marker}world${marker}`);
    const undo = formatSource(formatted, edit.start, edit.end, action);
    assert.equal(formatted.slice(0, undo.from) + undo.text + formatted.slice(undo.to), 'Hello world');
  }
});

test('source formatting covers headings, lists, indentation, links, and code fences', () => {
  assert.equal(formatSource('Hello', 0, 5, 'heading', '3').text, '### Hello');
  assert.equal(formatSource('### Hello', 0, 9, 'heading', '0').text, 'Hello');
  assert.equal(formatSource('a\nb', 0, 3, 'ordered').text, '1. a\n2. b');
  assert.equal(formatSource('a\nb', 0, 3, 'task').text, '- [ ] a\n- [ ] b');
  assert.equal(formatSource('a\nb', 0, 3, 'quote').text, '> a\n> b');
  assert.equal(formatSource('  a\n  b', 0, 7, 'outdent').text, 'a\nb');
  assert.equal(formatSource('\nnext', 0, 0, 'heading', '1').from, 0);
  assert.equal(formatSource('site', 0, 4, 'link', 'https://example.com/a b').text, '[site](https://example.com/a%20b)');
  assert.equal(formatSource('```', 0, 3, 'code').text, '````\n```\n````');
});

test('source highlighting colors Markdown syntax while preserving and escaping the exact text', () => {
  const source = '# Heading\n\n**bold** and *italic* with [a link](https://example.com).\n\n```js\nconst x = "<script>";\n```\n';
  const html = highlightMarkdownSource(source);
  for (const token of ['hljs-section', 'hljs-strong', 'hljs-emphasis', 'hljs-link', 'hljs-code']) assert.ok(html.includes(token), token);
  assert.equal(html.includes('<script>'), false);
  const text = html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  assert.equal(text, source);
});

test('closed math does not leak subscript highlighting into following headings or prose', () => {
  const source = String.raw`Inline math: $E = mc^2$.

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

## Details and notes

The Markdown file remains the source of truth.

*Normal italic* still works.
`;
  const html = highlightMarkdownSource(source);
  assert.match(html, /class="hljs-section">## Details and notes<\/span>/);
  assert.match(html, /class="hljs-emphasis">\*Normal italic\*<\/span>/);
  assert.equal((html.match(/class="hljs-emphasis"/g) ?? []).length, 1);
  assert.ok(html.includes('\n\nThe Markdown file remains the source of truth.\n\n'));
});

test('math scopes respect headings, emphasis, escaped dollars, and code delimiters', () => {
  for (const source of [
    '# Math $x_0$\n\n## Next\n',
    'Math $x_0$\n=============\n\n## Next\n',
    '**Math $x_0$**\n\n## Next\n',
    '$x_0\n\n## Next\n',
    String.raw`$$\text{\$amount} + x_0$$` + '\n\n## Next\n',
  ]) assert.match(highlightMarkdownSource(source), /class="hljs-section">## Next<\/span>/, source);
  for (const source of [String.raw`\$5.00 and **bold**`, '`$x_0$`', '```text\n$x_0$\n```']) {
    assert.equal(highlightMarkdownSource(source).includes('hljs-formula'), false, source);
  }
});
