import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx, schemaCtx, serializerCtx, commandsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { ParserState } from '@milkdown/kit/transformer';
import { commonmark, updateLinkCommand, inputRules as commonInput, markInputRules as commonMarks } from '@milkdown/kit/preset/commonmark';
import { gfm, inputRules as gfmInput, markInputRules as gfmMarks, pasteRules as gfmPaste } from '@milkdown/kit/preset/gfm';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { cursor } from '@milkdown/kit/plugin/cursor';
import { trailing } from '@milkdown/kit/plugin/trailing';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, Selection } from '@milkdown/kit/prose/state';
import { toggleMark, setBlockType, wrapIn, lift } from '@milkdown/kit/prose/commands';
import { wrapInList, liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list';
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable } from '@milkdown/kit/prose/tables';
import type { Command } from '@milkdown/kit/prose/state';
import { markdownProcessor, preserveMarkdown, lineEnding, withLineEnding, parseMarkdown, fencedCode } from '../markdown';
import { renderMarkdown } from '../render';
import type { Nodes } from 'mdast';
import { projectMarkdown } from './projection';
import { opaqueBlock, opaqueInline, codeWithMetadata, nodeViews } from './nodes';
import { highlighting } from './highlight';
import { autoMarkdown } from './auto';
import { enhance } from './enhance';
import { formatSource, type SourceFormat } from './source';
import { highlightMarkdownSource } from './sourceHighlight';
import { documentHeadings } from './toc';
import { buildToolbar, type TableAction } from './toolbar';
import { icon } from './icons';
import type { EditorMessage, HostMessage, Settings, EditorMode } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(message: EditorMessage): void; getState?(): { mode?: EditorMode; toc?: boolean }; setState?(state: { mode: EditorMode; toc?: boolean }): void };
const vscode = acquireVsCodeApi();
const send = (message: EditorMessage) => vscode.postMessage(message);
const root = document.querySelector<HTMLElement>('#editor')!;
const workspace = document.querySelector<HTMLElement>('#workspace')!;
const visualPane = document.querySelector<HTMLElement>('#visual-pane')!;
const sourcePane = document.querySelector<HTMLElement>('#source-pane')!;
const previewPane = document.querySelector<HTMLElement>('#preview-pane')!;
const source = document.querySelector<HTMLTextAreaElement>('#source')!;
const sourceHighlight = document.querySelector<HTMLElement>('#source-highlight')!;
const sourceTokens = sourceHighlight.querySelector('code')!;
const toolbar = document.querySelector<HTMLElement>('#toolbar')!;
const status = document.querySelector<HTMLElement>('#status')!;
const toc = document.querySelector<HTMLElement>('#toc')!;
const tocEntries = document.querySelector<HTMLElement>('#toc-entries')!;
const wideEditor = matchMedia('(min-width: 1100px)');
const savedState = vscode.getState?.();
let tocPreference = savedState?.toc;
let editor: Editor | undefined, ready = false, suppress = false, isDirty = false;
let mode: EditorMode = savedState?.mode ?? 'wysiwyg';
let pane: 'visual' | 'source' = 'visual', currentSource = '', eol = '\n';
let settings: Settings = { autoFormatMarkdown: true, profile: 'github' };
let version = 0, sequence = 0, assets = 0, scrolling = false, modeRequest = 0;
const pending = new Set<number>(), actions: (() => void)[] = [];
const images = new Map<number, { image: HTMLImageElement; path: string }>();
const inSource = () => mode === 'source' || (mode === 'split' && pane === 'source');
const saveViewState = () => vscode.setState?.({ mode, toc: tocPreference });

function updateTocVisibility() {
  toc.hidden = !(tocPreference ?? wideEditor.matches);
  rebuildToolbar();
}
wideEditor.addEventListener('change', updateTocVisibility);

function updateToc() {
  const headings = documentHeadings(source.value);
  tocEntries.replaceChildren();
  if (!headings.length) { tocEntries.textContent = 'No headings yet.'; return; }
  for (const [index, heading] of headings.entries()) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = heading.text || 'Untitled heading'; button.title = button.textContent;
    button.style.paddingLeft = `${10 + (heading.level - 1) * 12}px`;
    button.onclick = () => {
      scrolling = true; requestAnimationFrame(() => { scrolling = false; });
      if (mode === 'source' || mode === 'split') {
        source.focus(); source.setSelectionRange(heading.offset, heading.offset);
        source.scrollTop = (heading.line - 1) * parseFloat(getComputedStyle(source).lineHeight);
        syncSourceHighlightScroll();
        if (mode === 'source') return;
      }
      if (mode === 'preview') {
        const matches = Array.from(previewPane.querySelectorAll<HTMLElement>(`h${heading.level}`)).filter(element => {
          const copy = element.cloneNode(true) as HTMLElement;
          copy.querySelectorAll('.katex').forEach(math => math.replaceWith(document.createTextNode(math.querySelector('annotation')?.textContent ?? '')));
          copy.querySelectorAll('img').forEach(image => image.replaceWith(document.createTextNode(image.alt)));
          return copy.textContent === heading.text;
        });
        const duplicate = headings.slice(0, index).filter(item => item.level === heading.level && item.text === heading.text).length;
        const target = matches[duplicate];
        if (target) {
          for (let parent = target.parentElement; parent && parent !== previewPane; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
          target.scrollIntoView({ block: 'start' }); target.tabIndex = -1; target.focus({ preventScroll: true });
        }
        return;
      }
      editor?.action(ctx => {
        const view = ctx.get(editorViewCtx);
        const blocks = parseMarkdown(source.value).children;
        const blockIndex = blocks.findIndex(block => block.position!.end.offset! > heading.offset);
        if (blockIndex < 0 || blockIndex >= view.state.doc.childCount) return;
        let position = 0;
        for (let i = 0; i < blockIndex; i++) position += view.state.doc.child(i).nodeSize;
        const block = view.state.doc.child(blockIndex), blockPosition = position;
        let ordinal = headings.slice(0, index).filter(item => item.offset >= blocks[blockIndex].position!.start.offset!).length;
        if (block.type.name !== 'heading') block.descendants((node, offset) => {
          if (node.type.name === 'heading' && ordinal-- === 0) position = blockPosition + 1 + offset;
        });
        if (mode !== 'split') view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(position + 1))));
        (view.nodeDOM(position) as HTMLElement | null)?.scrollIntoView({ block: 'start' });
        if (mode !== 'split') view.focus();
      });
    };
    tocEntries.append(button);
  }
}

function showStatus(text: string, error = false) { status.textContent = text; status.classList.toggle('error', error); }
function documentStatus() { showStatus(pending.size ? 'Updating Markdown…' : isDirty ? 'Unsaved changes' : 'Saved'); }
function markdown(): string { return editor!.action(ctx => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)); }
function postEdit(text: string, mode: 'source' | 'visual') {
  pending.add(++sequence); send({ type: 'edit', version, sequence, markdown: text, mode }); documentStatus();
}
function afterEdits(action: () => void) { if (pending.size) actions.push(action); else action(); }
function syncSourceHighlightScroll() { sourceHighlight.scrollTop = source.scrollTop; sourceHighlight.scrollLeft = source.scrollLeft; }
function highlightSourceText() {
  sourceTokens.innerHTML = highlightMarkdownSource(source.value) + '\n';
  syncSourceHighlightScroll();
  updateToc();
}
function updateSource(text: string) {
  const value = text.replace(/\r\n/g, '\n');
  if (source.value === value) return;
  const start = source.selectionStart, end = source.selectionEnd, scroll = source.scrollTop, left = source.scrollLeft;
  source.value = value; source.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length)); source.scrollTop = scroll; source.scrollLeft = left;
  highlightSourceText();
}
function renderVisual(text: string) {
  suppress = true;
  try {
    editor!.action(ctx => {
      const view = ctx.get(editorViewCtx), next = ctx.get(parserCtx)(text);
      if (view.state.doc.eq(next)) return;
      const selection = view.state.selection.from, tr = view.state.tr.replaceWith(0, view.state.doc.content.size, next.content);
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(selection, tr.doc.content.size)))); view.dispatch(tr);
    });
  } finally { suppress = false; }
}
function changed() {
  if (!ready || suppress || mode === 'preview') return;
  const serialized = markdown(); currentSource = preserveMarkdown(currentSource, serialized);
  updateSource(currentSource); postEdit(serialized, 'visual');
}
function sourceChanged() {
  if (mode === 'preview') return;
  highlightSourceText();
  currentSource = withLineEnding(source.value, eol); postEdit(currentSource, 'source'); renderVisual(currentSource);
}
function renderPreview() {
  const scroll = previewPane.scrollTop;
  previewPane.innerHTML = renderMarkdown(currentSource, settings.profile);
  previewPane.querySelectorAll<HTMLImageElement>('img').forEach(image => resolveImage(image.getAttribute('src') ?? '', image));
  const codeBlocks = new Map<string, { text: string; language: string }>();
  const collect = (node: Nodes) => {
    if (node.type === 'code') codeBlocks.set(node.value + '\n', { text: node.value, language: node.lang ?? '' });
    if ('children' in node) node.children.forEach(collect);
  };
  collect(parseMarkdown(currentSource));
  for (const pre of previewPane.querySelectorAll('pre')) {
    const code = pre.querySelector('code'); if (!code) continue;
    const block = codeBlocks.get(code.textContent ?? '') ?? { text: code.textContent ?? '', language: '' };
    const wrapper = document.createElement('div'); wrapper.className = 'preview-code-block';
    const controls = document.createElement('div'); controls.className = 'preview-copy-controls';
    for (const [label, glyph, text] of [['Copy Code', 'copy', block.text], ['Copy Code Block as Markdown', 'code', fencedCode(block.text, block.language)]] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.append(icon(glyph));
      button.onclick = () => send({ type: 'copy', text }); controls.append(button);
    }
    pre.replaceWith(wrapper); wrapper.append(controls, pre);
  }
  previewPane.scrollTop = scroll; void enhance(previewPane);
}
function setMode(value: EditorMode, focus = true) {
  const request = ++modeRequest;
  if (value === 'preview' && pending.size) { afterEdits(() => { if (request === modeRequest) setMode(value, focus); }); return; }
  mode = value; workspace.dataset.mode = value;
  visualPane.hidden = value === 'source' || value === 'preview'; sourcePane.hidden = value === 'wysiwyg' || value === 'preview'; previewPane.hidden = value !== 'preview';
  visualPane.inert = sourcePane.inert = value === 'preview';
  saveViewState(); send({ type: 'mode', mode }); updateTocVisibility();
  requestAnimationFrame(syncSourceHighlightScroll);
  if (value === 'preview') renderPreview();
  else if (value !== 'source') requestAnimationFrame(() => { void enhance(visualPane); });
  if (focus) {
    if (value === 'preview') previewPane.focus();
    else if (value === 'source') { pane = 'source'; source.focus(); }
    else { pane = 'visual'; editor?.action(ctx => ctx.get(editorViewCtx).focus()); }
  }
}
function resolveImage(path: string, image: HTMLImageElement) {
  image.dataset.sourcePath = path; image.removeAttribute('src');
  if (/^https?:\/\//i.test(path)) { image.src = path; return; }
  if (!path || /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')) { image.title = 'Unsupported image URL'; return; }
  const request = ++assets; images.set(request, { image, path }); send({ type: 'asset', request, path });
}
function run(command: Command) {
  editor?.action(ctx => { const view = ctx.get(editorViewCtx); command(view.state, view.dispatch, view); if (!inSource()) view.focus(); });
}
function insert(text: string) {
  editor?.action(ctx => {
    const view = ctx.get(editorViewCtx), parsed = ctx.get(parserCtx)(text);
    view.dispatch(view.state.tr.replaceSelectionWith(parsed.firstChild!, false).scrollIntoView()); view.focus();
  });
}
function applySource(action: SourceFormat, value?: string, label?: string) {
  if (mode === 'preview') return;
  const edit = formatSource(source.value, source.selectionStart, source.selectionEnd, action, value, label);
  source.setRangeText(edit.text, edit.from, edit.to, 'end'); source.setSelectionRange(edit.start, edit.end);
  pane = 'source'; source.focus(); sourceChanged();
}
function format(action: SourceFormat, value?: string) {
  if (mode === 'preview') return;
  if (inSource()) { applySource(action, value); return; }
  editor?.action(ctx => {
    const view = ctx.get(editorViewCtx), { nodes, marks } = view.state.schema;
    const mark = { strong: 'strong', emphasis: 'emphasis', strike: 'strike_through', inlineCode: 'inlineCode' };
    if (action in mark) run(toggleMark(marks[mark[action as keyof typeof mark]]));
    else if (action === 'heading') run(setBlockType(Number(value) ? nodes.heading : nodes.paragraph, Number(value) ? { level: Number(value) } : undefined));
    else if (action === 'bullet' || action === 'ordered') run(wrapInList(nodes[action === 'bullet' ? 'bullet_list' : 'ordered_list']));
    else if (action === 'task') insert('- [ ] Task');
    else if (action === 'quote') run(wrapIn(nodes.blockquote));
    else if (action === 'code') run(setBlockType(nodes.code_block, { language: '' }));
    else if (action === 'indent') run(sinkListItem(nodes.list_item));
    else if (action === 'outdent') { if (!liftListItem(nodes.list_item)(view.state, view.dispatch)) run(lift); view.focus(); }
  });
}
function formattingShortcut(event: KeyboardEvent): boolean {
  if (mode === 'preview') return false;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  const key = event.key.toLowerCase();
  const action = event.shiftKey ? key === 'x' ? 'strike' : undefined : ({ b: 'strong', i: 'emphasis', e: 'inlineCode' } as const)[key as 'b' | 'i' | 'e'];
  if (!action && (event.shiftKey || key !== 'k')) return false;
  event.preventDefault(); event.stopPropagation();
  if (action) format(action); else toolbar.querySelector<HTMLButtonElement>('[data-shortcut=link]')?.click();
  return true;
}
function sourcePosition() {
  const line = source.value.slice(0, source.selectionStart).split('\n').length;
  const tree = parseMarkdown(currentSource);
  let index = tree.children.findIndex(node => node.position!.end.line >= line);
  if (index < 0) index = tree.children.length;
  return { index, line, node: tree.children[index] };
}
function syncSourceSelection(table = false) {
  if (!ready || (!table && mode !== 'split')) return false;
  const { index, line, node } = sourcePosition();
  let positioned = true;
  suppress = true;
  try {
    editor!.action(ctx => {
      const view = ctx.get(editorViewCtx); let offset = 0;
      for (let i = 0; i < Math.min(index, view.state.doc.childCount); i++) offset += view.state.doc.child(i).nodeSize;
      let selection = offset;
      if (table && node?.type === 'table') {
        const tableNode = view.state.doc.maybeChild(index);
        if (tableNode?.type.name !== 'table') { positioned = false; showStatus('This table contains source-only markup; edit it directly in Source view.'); return; }
        let row = node.children.findIndex(row => row.position!.end.line >= line); if (row < 0) row = node.children.length - 1;
        if (line === node.position!.start.line + 1) row = 0;
        const column = source.selectionStart - source.value.lastIndexOf('\n', source.selectionStart - 1);
        let cell = node.children[row].children.findIndex(cell => cell.position!.end.column >= column); if (cell < 0) cell = node.children[row].children.length - 1;
        selection += 1;
        for (let i = 0; i < row; i++) selection += tableNode.child(i).nodeSize;
        selection += 1;
        for (let i = 0; i < cell; i++) selection += tableNode.child(row).child(i).nodeSize;
        selection += 1;
      }
      view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(Math.min(selection, view.state.doc.content.size)))));
      if (mode === 'split') (view.nodeDOM(offset) as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    });
  } finally { suppress = false; }
  return positioned;
}
function tableAction(action: TableAction) {
  if (mode === 'preview') return;
  const snippet = '| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |';
  if (action === 'insert') {
    if (inSource()) {
      source.setRangeText('\n\n' + snippet + '\n\n', source.selectionStart, source.selectionEnd, 'end'); source.focus(); sourceChanged();
    } else insert(snippet);
    return;
  }
  if (inSource()) {
    if (sourcePosition().node?.type !== 'table') { showStatus('Place the source cursor inside a table first.'); return; }
    if (!syncSourceSelection(true)) return;
  }
  run({ row: addRowAfter, column: addColumnAfter, deleteRow, deleteColumn, delete: deleteTable }[action]);
  if (inSource()) source.focus();
}
async function fields(title: string, labels: string[]): Promise<string[] | undefined> {
  const dialog = document.createElement('dialog'), form = document.createElement('form'); form.method = 'dialog';
  const heading = document.createElement('h2'); heading.textContent = title; form.append(heading);
  const inputs = labels.map(label => {
    const wrapper = document.createElement('label'), input = document.createElement('input'); wrapper.textContent = label; wrapper.append(input); form.append(wrapper); return input;
  });
  const submit = document.createElement('button'); submit.textContent = 'Insert'; submit.value = 'insert';
  const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.value = 'cancel';
  form.append(submit, cancel); dialog.append(form); document.body.append(dialog); dialog.showModal(); inputs[0]?.focus();
  return new Promise(resolve => dialog.addEventListener('close', () => {
    const result = dialog.returnValue === 'insert' ? inputs.map(input => input.value) : undefined; dialog.remove(); resolve(result);
  }, { once: true }));
}
function rebuildToolbar() {
  buildToolbar(toolbar, settings, mode, {
    format, table: tableAction, mode: setMode,
    tocVisible: !toc.hidden,
    toc: () => { tocPreference = toc.hidden; saveViewState(); updateTocVisibility(); },
    command: command => afterEdits(() => send({ type: 'command', command })),
    profile: profile => send({ type: 'profile', profile }),
    link: () => { const raw = inSource(); void fields('Link', ['URL']).then(values => {
      if (!values?.[0]) return;
      if (raw) { applySource('link', values[0]); return; }
      editor?.action(ctx => {
        const view = ctx.get(editorViewCtx), { state } = view, link = state.schema.marks.link.create({ href: values[0] });
        if (!state.selection.empty) view.dispatch(state.tr.addMark(state.selection.from, state.selection.to, link));
        else if (!ctx.get(commandsCtx).call(updateLinkCommand.key, { href: values[0] })) view.dispatch(state.tr.addStoredMark(link)); view.focus();
      });
    }); },
    image: () => { const raw = inSource(); void fields('Image', ['Relative path or HTTPS URL', 'Alternative text']).then(values => {
      if (!values?.[0]) return;
      if (raw) { applySource('image', values[0], values[1]); return; }
      editor?.action(ctx => { const view = ctx.get(editorViewCtx); view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.image.create({ src: values[0], alt: values[1], title: '' })).scrollIntoView()); view.focus(); });
    }); },
  });
}
async function initialize() {
  const disabled = new Set([...commonInput, ...commonMarks, ...gfmInput, ...gfmMarks, ...gfmPaste]);
  editor = await Editor.make().config(ctx => {
    ctx.set(rootCtx, root); ctx.set(defaultValueCtx, '');
    ctx.update(remarkStringifyOptionsCtx, options => ({ ...options, bullet: '-' as const, emphasis: '*' as const, strong: '*' as const, fences: true, listItemIndent: 'one' as const }));
  }).use($prose(ctx => autoMarkdown(ctx, () => settings.autoFormatMarkdown, direction => afterEdits(() => send({ type: 'history', direction })))))
    .use(commonmark.filter(plugin => !disabled.has(plugin))).use(gfm.filter(plugin => !disabled.has(plugin)))
    .use(codeWithMetadata).use(opaqueBlock).use(opaqueInline).use(nodeViews(send, () => settings, resolveImage))
    .use($prose(highlighting)).use(clipboard).use(cursor).use(trailing)
    .use($prose(() => new Plugin({ view: () => ({ update(view, previous) {
      if (!view.state.doc.eq(previous.doc)) changed();
      if (mode === 'split' && !suppress && view.hasFocus() && !view.state.selection.eq(previous.selection)) {
        const node = parseMarkdown(currentSource).children[view.state.selection.$from.index(0)];
        const offset = node ? currentSource.slice(0, node.position!.start.offset).replace(/\r\n/g, '\n').length : source.value.length;
        source.setSelectionRange(offset, offset);
      }
    } }) }))).create();
  editor.action(ctx => {
    const processor = markdownProcessor().use(function () { this.parser = projectMarkdown; });
    ctx.set(parserCtx, ParserState.create(ctx.get(schemaCtx), processor));
    const view = ctx.get(editorViewCtx); view.dom.setAttribute('aria-label', 'Markdown document'); view.dom.setAttribute('role', 'textbox'); view.dom.setAttribute('aria-multiline', 'true');
  });
  root.addEventListener('focusin', () => { pane = 'visual'; });
  root.addEventListener('keydown', event => { if (!(event.target as Element).closest('input,textarea')) formattingShortcut(event); }, true);
  source.addEventListener('focus', () => { pane = 'source'; });
  source.addEventListener('input', sourceChanged);
  source.addEventListener('click', () => syncSourceSelection()); source.addEventListener('keyup', () => syncSourceSelection());
  source.addEventListener('keydown', event => {
    if (formattingShortcut(event)) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); afterEdits(() => send({ type: 'history', direction: event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo' }));
    } else if (event.key === 'Tab' && !mod && !event.altKey) { event.preventDefault(); applySource(event.shiftKey ? 'outdent' : 'indent'); }
    else if (event.key === 'Escape') { event.preventDefault(); toolbar.querySelector<HTMLElement>('[aria-label="Source view"]')?.focus(); }
  });
  source.setAttribute('aria-description', 'Tab indents, Shift+Tab outdents, and Escape focuses the toolbar.');
  window.addEventListener('keydown', event => {
    if (mode === 'preview' && (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); afterEdits(() => send({ type: 'command', command: 'save' })); }
  });
  const syncScroll = (from: HTMLElement, to: HTMLElement) => {
    if (mode !== 'split' || scrolling) return; scrolling = true;
    to.scrollTop = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight) * Math.max(0, to.scrollHeight - to.clientHeight);
    requestAnimationFrame(() => { scrolling = false; });
  };
  source.addEventListener('scroll', () => { syncSourceHighlightScroll(); syncScroll(source, visualPane); }, { passive: true });
  visualPane.addEventListener('scroll', () => syncScroll(visualPane, source), { passive: true });
  for (const container of [root, previewPane]) container.addEventListener('click', event => {
    const link = (event.target as Element).closest('a'); if (!link) return;
    event.preventDefault(); const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) container.querySelector('#' + CSS.escape(href.slice(1)))?.scrollIntoView({ block: 'center' });
    else afterEdits(() => send({ type: 'link', href }));
  });
  ready = true; setMode(mode, false);
}
async function receive(message: HostMessage) {
  if (message.type === 'status') { showStatus(message.text, message.error); return; }
  if (message.type === 'saved') { isDirty = false; documentStatus(); return; }
  if (message.type === 'mode') { setMode(message.mode === 'toggle' ? mode === 'source' ? 'wysiwyg' : 'source' : message.mode); return; }
  if (message.type === 'asset') {
    const asset = images.get(message.request); images.delete(message.request);
    if (asset && asset.image.dataset.sourcePath === asset.path) { if (message.uri) asset.image.src = message.uri; else asset.image.title = message.error ?? 'Image unavailable'; } return;
  }
  if (message.type === 'settings') { settings = message.settings; root.className = `markdown-body profile-${settings.profile}`; if (ready) { rebuildToolbar(); if (mode === 'preview') renderPreview(); } return; }
  settings = message.settings; version = message.version; isDirty = message.isDirty;
  if (!editor) await initialize();
  root.className = `markdown-body profile-${settings.profile}`;
  if (message.acknowledgment !== undefined) {
    pending.delete(message.acknowledgment);
    if (!pending.size) { currentSource = message.source; updateSource(currentSource); documentStatus(); actions.splice(0).forEach(action => action()); } return;
  }
  if (pending.size) { send({ type: 'recover', markdown: currentSource }); pending.clear(); actions.length = 0; }
  currentSource = message.source; eol = lineEnding(currentSource); updateSource(currentSource); renderVisual(currentSource);
  if (mode === 'preview') renderPreview();
  rebuildToolbar(); documentStatus();
}
let receiving = Promise.resolve();
window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  receiving = receiving.then(() => receive(event.data)).catch(error => showStatus(`Editor error: ${error instanceof Error ? error.message : String(error)}. Use Reopen Editor With → Text Editor to access the Markdown.`, true));
});
send({ type: 'ready' });
