import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx, schemaCtx, serializerCtx, commandsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { ParserState } from '@milkdown/kit/transformer';
import { commonmark, updateLinkCommand, inputRules as commonInput, markInputRules as commonMarks } from '@milkdown/kit/preset/commonmark';
import { gfm, inputRules as gfmInput, markInputRules as gfmMarks, pasteRules as gfmPaste } from '@milkdown/kit/preset/gfm';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { cursor } from '@milkdown/kit/plugin/cursor';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, Selection } from '@milkdown/kit/prose/state';
import { toggleMark, setBlockType, wrapIn, lift } from '@milkdown/kit/prose/commands';
import { wrapInList, liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list';
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable } from '@milkdown/kit/prose/tables';
import type { Command } from '@milkdown/kit/prose/state';
import { markdownProcessor } from '../markdown';
import { projectMarkdown } from './projection';
import { opaqueBlock, opaqueInline, codeWithMetadata, nodeViews } from './nodes';
import { highlighting } from './highlight';
import { autoMarkdown } from './auto';
import type { EditorMessage, HostMessage, Settings } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(message: EditorMessage): void };
const vscode = acquireVsCodeApi();
const send = (message: EditorMessage) => vscode.postMessage(message);
const root = document.querySelector<HTMLElement>('#editor')!;
const toolbar = document.querySelector<HTMLElement>('#toolbar')!;
const status = document.querySelector<HTMLElement>('#status')!;
let editor: Editor | undefined, ready = false, suppress = false;
let settings: Settings = { autoFormatMarkdown: true, profile: 'github' };
let version = 0, sequence = 0, dirty = false;
const pending = new Set<number>();
let revealing = false, lastScrollBlock = -1, scrollFrame = 0;
let assets = 0;
const images = new Map<number, { image: HTMLImageElement; path: string }>();
const actions: (() => void)[] = [];

function showStatus(text: string, error = false) { status.textContent = text; status.classList.toggle('error', error); }
function markdown(): string { return editor!.action(ctx => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)); }
function flush() {
  if (!ready || !dirty) return;
  dirty = false; pending.add(++sequence);
  send({ type: 'edit', version, sequence, markdown: markdown() });
  showStatus('Saving changes to the document…');
}
function afterEdits(action: () => void) {
  actions.push(action); flush();
  if (!dirty && !pending.size) actions.splice(0).forEach(action => action());
}
function changed() {
  if (!ready || suppress) return;
  dirty = true; flush();
}
function resolveImage(path: string, image: HTMLImageElement) {
  image.dataset.sourcePath = path;
  image.removeAttribute('src');
  if (/^https?:\/\//i.test(path)) { image.src = path; return; }
  if (!path || /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')) { image.title = 'Unsupported image URL'; return; }
  const request = ++assets;
  images.set(request, { image, path }); send({ type: 'asset', request, path });
}
function run(command: Command) {
  editor?.action(ctx => { const view = ctx.get(editorViewCtx); command(view.state, view.dispatch, view); view.focus(); });
}
function insert(markdown: string) {
  editor?.action(ctx => {
    const view = ctx.get(editorViewCtx), parsed = ctx.get(parserCtx)(markdown);
    view.dispatch(view.state.tr.replaceSelectionWith(parsed.childCount === 1 ? parsed.firstChild! : view.state.schema.nodes.paragraph.create(), false).scrollIntoView());
    view.focus();
  });
}

async function fields(title: string, labels: string[]): Promise<string[] | undefined> {
  const dialog = document.createElement('dialog'), form = document.createElement('form'); form.method = 'dialog';
  const heading = document.createElement('h2'); heading.textContent = title; form.append(heading);
  const inputs = labels.map(label => {
    const wrapper = document.createElement('label'), input = document.createElement('input');
    wrapper.textContent = label; wrapper.append(input); form.append(wrapper); return input;
  });
  const submit = document.createElement('button'); submit.textContent = 'Insert'; submit.value = 'insert';
  const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.value = 'cancel';
  form.append(submit, cancel); dialog.append(form); document.body.append(dialog); dialog.showModal(); inputs[0]?.focus();
  return new Promise(resolve => dialog.addEventListener('close', () => {
    const result = dialog.returnValue === 'insert' ? inputs.map(input => input.value) : undefined; dialog.remove(); resolve(result);
  }, { once: true }));
}

function buildToolbar() {
  const focused = toolbar.contains(document.activeElement) ? document.activeElement?.getAttribute('aria-label') : null;
  toolbar.replaceChildren();
  const button = (label: string, title: string, action: () => void) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = title; button.setAttribute('aria-label', title);
    button.onmousedown = event => event.preventDefault(); button.onclick = action; toolbar.append(button); return button;
  };
  const mark = (name: string) => editor?.action(ctx => { const view = ctx.get(editorViewCtx); const type = view.state.schema.marks[name]; if (type) run(toggleMark(type)); });
  const block = (name: string, attrs?: Record<string, unknown>) => editor?.action(ctx => { const view = ctx.get(editorViewCtx); const type = view.state.schema.nodes[name]; if (type) run(setBlockType(type, attrs)); });
  const list = (name: string) => editor?.action(ctx => { const view = ctx.get(editorViewCtx); const type = view.state.schema.nodes[name]; if (type) run(wrapInList(type)); });
  const heading = document.createElement('select'); heading.setAttribute('aria-label', 'Paragraph or heading');
  for (let level = 0; level <= 6; level++) heading.add(new Option(level ? `Heading ${level}` : 'Paragraph', String(level)));
  heading.onchange = () => block(heading.value === '0' ? 'paragraph' : 'heading', heading.value === '0' ? undefined : { level: Number(heading.value) }); toolbar.append(heading);
  button('B', 'Bold (Ctrl/Cmd+B)', () => mark('strong'));
  button('I', 'Italic (Ctrl/Cmd+I)', () => mark('emphasis'));
  button('S̶', 'Strikethrough', () => mark('strike_through'));
  button('`…`', 'Inline code', () => mark('inlineCode'));
  button('Link', 'Insert or edit link', () => { void fields('Link', ['URL']).then(values => {
    if (values?.[0]) editor?.action(ctx => {
      const view = ctx.get(editorViewCtx), { state } = view, link = state.schema.marks.link.create({ href: values[0] });
      if (!state.selection.empty) view.dispatch(state.tr.addMark(state.selection.from, state.selection.to, link));
      else if (!ctx.get(commandsCtx).call(updateLinkCommand.key, { href: values[0] })) view.dispatch(state.tr.addStoredMark(link));
      view.focus();
    });
  }); });
  button('Image', 'Insert image', () => { void fields('Image', ['Relative path or HTTPS URL', 'Alternative text']).then(values => {
    if (values?.[0]) editor?.action(ctx => { const view = ctx.get(editorViewCtx); view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.image.create({ src: values[0], alt: values[1], title: '' })).scrollIntoView()); view.focus(); });
  }); });
  button('• List', 'Bullet list', () => list('bullet_list'));
  button('1. List', 'Numbered list', () => list('ordered_list'));
  button('☑ Task', 'Insert task list', () => insert('- [ ] Task'));
  button('Quote', 'Block quote', () => editor?.action(ctx => { const view = ctx.get(editorViewCtx); run(wrapIn(view.state.schema.nodes.blockquote)); }));
  button('Code', 'Code block', () => block('code_block', { language: '' }));
  button('Table', 'Insert table', () => insert('| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |'));
  button('+ Row', 'Add table row', () => run(addRowAfter));
  button('+ Column', 'Add table column', () => run(addColumnAfter));
  button('− Row', 'Delete table row', () => run(deleteRow));
  button('− Column', 'Delete table column', () => run(deleteColumn));
  button('− Table', 'Delete table', () => run(deleteTable));
  button('Outdent', 'Outdent list or block', () => editor?.action(ctx => { const view = ctx.get(editorViewCtx); if (!liftListItem(view.state.schema.nodes.list_item)(view.state, view.dispatch)) run(lift); view.focus(); }));
  button('Indent', 'Indent list item', () => editor?.action(ctx => run(sinkListItem(ctx.get(editorViewCtx).state.schema.nodes.list_item))));
  const auto = button(settings.autoFormatMarkdown ? 'Auto Markdown: On' : 'Auto Markdown: Off', 'Toggle automatic Markdown formatting; turn off to type literal Markdown', () => afterEdits(() => send({ type: 'command', command: 'auto' })));
  auto.setAttribute('aria-pressed', String(settings.autoFormatMarkdown)); auto.className = 'auto-toggle';
  const profile = document.createElement('select'); profile.setAttribute('aria-label', 'Rendering profile');
  profile.add(new Option('GitHub', 'github')); profile.add(new Option('GitLab', 'gitlab')); profile.value = settings.profile;
  profile.onchange = () => send({ type: 'profile', profile: profile.value as Settings['profile'] }); toolbar.append(profile);
  for (const [label, command] of [['Source', 'source'], ['Split', 'split'], ['Normalize', 'normalize'], ['HTML', 'html'], ['PDF', 'pdf']] as const) {
    button(label, `${label === 'Normalize' ? 'Normalize Document (undoable)' : label}`, () => afterEdits(() => send({ type: 'command', command })));
  }
  const controls = Array.from(toolbar.querySelectorAll<HTMLElement>('button,select'));
  const focusIndex = Math.max(0, controls.findIndex(control => control.getAttribute('aria-label') === focused));
  controls.forEach((control, i) => { control.tabIndex = i === focusIndex ? 0 : -1; });
  if (focused) controls[focusIndex]?.focus();
  toolbar.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.target instanceof HTMLSelectElement) return;
    event.preventDefault(); const current = controls.indexOf(document.activeElement as HTMLElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length;
    controls.forEach((control, i) => { control.tabIndex = i === index ? 0 : -1; }); controls[index].focus();
  };
}

async function initialize() {
  const disabled = new Set([...commonInput, ...commonMarks, ...gfmInput, ...gfmMarks, ...gfmPaste]);
  editor = await Editor.make().config(ctx => {
    ctx.set(rootCtx, root); ctx.set(defaultValueCtx, '');
    ctx.update(remarkStringifyOptionsCtx, options => ({ ...options, bullet: '-' as const, emphasis: '*' as const, strong: '*' as const, fences: true, listItemIndent: 'one' as const }));
  }).use($prose(ctx => autoMarkdown(ctx, () => settings.autoFormatMarkdown, direction => afterEdits(() => send({ type: 'history', direction })))))
    .use(commonmark.filter(plugin => !disabled.has(plugin)))
    .use(gfm.filter(plugin => !disabled.has(plugin)))
    .use(codeWithMetadata).use(opaqueBlock).use(opaqueInline).use(nodeViews(send, () => settings, resolveImage))
    .use($prose(highlighting))
    .use(clipboard).use(cursor)
    .use($prose(() => new Plugin({ view: () => ({ update(view, previous) {
      if (!view.state.doc.eq(previous.doc)) changed();
      if (!view.state.selection.eq(previous.selection) && view.hasFocus() && !suppress) {
        send({ type: 'reveal', block: view.state.selection.$from.index(0) });
      }
    } }) }))).create();
  editor.action(ctx => {
    // Use a source-preserving AST projection; the default parser can discard unsupported syntax.
    const processor = markdownProcessor().use(function () { this.parser = projectMarkdown; });
    ctx.set(parserCtx, ParserState.create(ctx.get(schemaCtx), processor));
    const view = ctx.get(editorViewCtx); view.dom.setAttribute('aria-label', 'Markdown document'); view.dom.setAttribute('role', 'textbox'); view.dom.setAttribute('aria-multiline', 'true');
  });
  root.addEventListener('click', event => {
    const link = (event.target as Element).closest('a');
    if (link) {
      event.preventDefault(); const href = link.getAttribute('href') ?? '';
      if (href.startsWith('#')) document.getElementById(href.slice(1))?.scrollIntoView({ block: 'center' });
      else afterEdits(() => send({ type: 'link', href }));
    }
  });
  window.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      if (revealing || suppress) return;
      editor?.action(ctx => {
        const view = ctx.get(editorViewCtx), top = toolbar.getBoundingClientRect().bottom + 8;
        let visible = -1;
        view.state.doc.forEach((_node, offset, index) => {
          const dom = view.nodeDOM(offset);
          if (visible < 0 && dom instanceof HTMLElement && dom.getBoundingClientRect().bottom > top) visible = index;
        });
        if (visible >= 0 && visible !== lastScrollBlock) { lastScrollBlock = visible; send({ type: 'reveal', block: visible, select: false }); }
      });
    });
  }, { passive: true });
  buildToolbar(); ready = true;
}

async function receive(message: HostMessage) {
  if (message.type === 'status') { showStatus(message.text, message.error); return; }
  if (message.type === 'asset') {
    const pending = images.get(message.request); images.delete(message.request);
    if (pending && pending.image.dataset.sourcePath === pending.path) {
      if (message.uri) pending.image.src = message.uri;
      else pending.image.title = message.error ?? 'Image unavailable';
    }
    return;
  }
  if (message.type === 'settings') {
    settings = message.settings; root.className = `markdown-body profile-${settings.profile}`;
    if (ready) buildToolbar(); return;
  }
  if (message.type === 'reveal') {
    revealing = true; lastScrollBlock = message.block;
    editor?.action(ctx => {
      const view = ctx.get(editorViewCtx); let offset = 0;
      for (let i = 0; i < Math.min(message.block, view.state.doc.childCount); i++) offset += view.state.doc.child(i).nodeSize;
      suppress = true;
      try { if (message.select !== false) view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(offset)))); (view.nodeDOM(offset) as HTMLElement | null)?.scrollIntoView({ block: 'nearest' }); }
      finally { suppress = false; }
    }); setTimeout(() => { revealing = false; }, 150); return;
  }
  settings = message.settings; version = message.version;
  if (!editor) await initialize();
  root.className = `markdown-body profile-${settings.profile}`;
  if (message.acknowledgment !== undefined) {
    pending.delete(message.acknowledgment); flush();
    if (!dirty && !pending.size) { showStatus('All changes are in the document.'); actions.splice(0).forEach(action => action()); }
    return;
  }
  if (dirty || pending.size) {
    send({ type: 'recover', markdown: markdown() });
    dirty = false; pending.clear(); actions.length = 0;
  }
  suppress = true;
  try {
    editor!.action(ctx => {
      const view = ctx.get(editorViewCtx), next = ctx.get(parserCtx)(message.source);
      if (!view.state.doc.eq(next)) {
        const selection = view.state.selection.from, tr = view.state.tr.replaceWith(0, view.state.doc.content.size, next.content);
        tr.setSelection(Selection.near(tr.doc.resolve(Math.min(selection, tr.doc.content.size)))); view.dispatch(tr);
      }
    });
  } finally { suppress = false; }
  buildToolbar(); showStatus(settings.autoFormatMarkdown ? 'Ready · Markdown shortcuts and Enter formatting are on.' : 'Ready · Auto Markdown is off. Typed Markdown stays literal.');
}

let receiving = Promise.resolve();
window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  receiving = receiving.then(() => receive(event.data)).catch(error => { showStatus(`Editor error: ${error instanceof Error ? error.message : String(error)}. Your Markdown source is unchanged; use Reopen Editor With → Text Editor to recover.`, true); });
});
window.addEventListener('blur', flush);
window.addEventListener('beforeunload', flush);
send({ type: 'ready' });
