import { $node, $view } from '@milkdown/kit/utils';
import { codeBlockSchema, imageSchema, listItemSchema } from '@milkdown/kit/preset/commonmark';
import type { Node } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { fencedCode } from '../markdown';
import { renderMarkdown } from '../render';
import { enhance } from './enhance';
import type { EditorMessage, Settings } from '../protocol';

function sourceNode(inline: boolean) {
  return $node(inline ? 'scribe_inline' : 'scribe_block', () => ({
    group: inline ? 'inline' : 'block', inline, atom: true, selectable: true,
    attrs: { value: { default: '' }, kind: { default: '' } },
    parseDOM: [{ tag: inline ? 'span[data-scribe-source]' : 'div[data-scribe-source]',
      getAttrs: dom => ({ value: (dom as HTMLElement).dataset.scribeSource ?? '', kind: '' }) }],
    toDOM: node => [inline ? 'span' : 'div', { 'data-scribe-source': node.attrs.value }, node.attrs.value],
    parseMarkdown: {
      match: node => node.type === (inline ? 'scribeInline' : 'scribeBlock'),
      runner: (state, node, type) => { state.addNode(type, { value: node.value, kind: node.kind }); },
    },
    toMarkdown: {
      match: node => node.type.name === (inline ? 'scribe_inline' : 'scribe_block'),
      runner: (state, node) => { state.addNode('html', undefined, node.attrs.value); },
    },
  }));
}

export const opaqueBlock = sourceNode(false), opaqueInline = sourceNode(true);

export const codeWithMetadata = codeBlockSchema.extendSchema(previous => ctx => {
  const schema = previous(ctx);
  return { ...schema, attrs: { ...schema.attrs, meta: { default: null } },
    parseMarkdown: { match: node => node.type === 'code', runner: (state, node, type) => {
      state.openNode(type, { language: node.lang ?? '', meta: node.meta ?? null });
      if (node.value) state.addText(String(node.value)); state.closeNode();
    } },
    toMarkdown: { match: node => node.type.name === 'code_block', runner: (state, node) => {
      state.addNode('code', undefined, node.textContent, { lang: node.attrs.language || null, meta: node.attrs.meta });
    } },
  };
});

export function nodeViews(send: (message: EditorMessage) => void, settings: () => Settings, resolveImage: (path: string, image: HTMLImageElement) => void) {
  const rawView = (inline: boolean) => (_ctx: unknown) => (initial: Node, view: EditorView, getPos: () => number | undefined): NodeView => {
    let node = initial, disposed = false, renderId = 0;
    const dom = document.createElement(inline ? 'span' : 'div');
    dom.className = inline ? 'source-inline' : 'source-block'; dom.contentEditable = 'false';
    const preview = document.createElement(inline ? 'span' : 'div');
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = inline ? 'Edit' : 'Edit source';
    edit.title = 'Edit the Markdown source for this content';
    const input = document.createElement('textarea'); input.hidden = true; input.setAttribute('aria-label', 'Markdown block source');
    const apply = document.createElement('button'); apply.textContent = 'Apply'; apply.hidden = true; apply.type = 'button';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.hidden = true; cancel.type = 'button';
    const draw = () => {
      const id = ++renderId;
      const value = String(node.attrs.value);
      if (['yaml', 'toml', 'definition'].includes(node.attrs.kind) || /^<!--/.test(value)) {
        preview.textContent = value;
        preview.className = 'source-literal';
      } else if (node.attrs.kind === 'footnoteReference') {
        preview.textContent = value; preview.className = 'footnote-reference';
      } else {
        const footnote = node.attrs.kind === 'footnoteDefinition' ? /^\[\^([^\]]+)\]:/.exec(value) : null;
        const wrapper = document.createElement('div'); wrapper.innerHTML = renderMarkdown(footnote ? `[^${footnote[1]}]\n\n${value}` : value, settings().profile);
        const article = wrapper.firstElementChild!;
        if (footnote) article.firstElementChild?.remove();
        if (inline && article.firstElementChild?.tagName === 'P') preview.replaceChildren(...article.firstElementChild.childNodes);
        else preview.replaceChildren(...article.childNodes);
        void enhance(preview).then(() => { if (!disposed && id === renderId) preview.querySelectorAll<HTMLImageElement>('img').forEach(img => resolveImage(img.getAttribute('src') ?? '', img)); });
      }
    };
    const editing = (on: boolean) => { input.hidden = apply.hidden = cancel.hidden = !on; preview.hidden = edit.hidden = on; };
    edit.onclick = () => { input.value = node.attrs.value; editing(true); input.focus(); };
    cancel.onclick = () => { editing(false); view.focus(); };
    apply.onclick = () => {
      const pos = getPos();
      if (pos !== undefined) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, value: input.value }));
      editing(false); view.focus();
    };
    input.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); cancel.click(); } if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); apply.click(); } };
    dom.append(preview, edit, input, apply, cancel); draw();
    return { dom, update(next) { if (next.type !== node.type) return false; node = next; draw(); return true; },
      stopEvent: event => !(event.target instanceof Element && event.target.closest('a')),
      ignoreMutation: () => true, destroy() { disposed = true; } };
  };
  const code = $view(codeBlockSchema.node, () => (initial, view, getPos) => {
    let node = initial, generation = 0;
    const dom = document.createElement('div'); dom.className = 'code-block';
    const controls = document.createElement('div'); controls.className = 'code-controls'; controls.contentEditable = 'false';
    const language = document.createElement('input'); language.setAttribute('aria-label', 'Code language'); language.placeholder = 'plain text';
    const copy = document.createElement('button'); copy.textContent = 'Copy Code'; copy.type = 'button';
    const copyMarkdown = document.createElement('button'); copyMarkdown.textContent = 'Copy Markdown'; copyMarkdown.title = 'Copy Code Block as Markdown'; copyMarkdown.type = 'button';
    const menu = document.createElement('div'); menu.className = 'code-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
    const menuCode = document.createElement('button'), menuMarkdown = document.createElement('button');
    for (const button of [menuCode, menuMarkdown]) { button.type = 'button'; button.setAttribute('role', 'menuitem'); }
    menuCode.textContent = 'Copy Code'; menuMarkdown.textContent = 'Copy Code Block as Markdown'; menu.append(menuCode, menuMarkdown);
    const pre = document.createElement('pre'), contentDOM = document.createElement('code'); pre.append(contentDOM);
    const diagram = document.createElement('div'); diagram.className = 'diagram-preview'; diagram.contentEditable = 'false';
    const draw = () => {
      language.value = node.attrs.language ?? '';
      const id = ++generation;
      diagram.hidden = language.value !== 'mermaid';
      if (!diagram.hidden) {
        const stage = document.createElement('div'); stage.innerHTML = renderMarkdown(fencedCode(node.textContent, 'mermaid'), settings().profile);
        void enhance(stage).then(() => { if (id === generation) diagram.replaceChildren(...stage.childNodes); });
      }
    };
    language.onchange = () => { const pos = getPos(); if (pos !== undefined) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: language.value })); };
    copy.onclick = () => send({ type: 'copy', text: node.textContent });
    copyMarkdown.onclick = () => send({ type: 'copy', text: fencedCode(node.textContent, node.attrs.language) });
    menuCode.onclick = () => copy.click(); menuMarkdown.onclick = () => copyMarkdown.click();
    const closeMenu = () => { menu.hidden = true; };
    document.addEventListener('click', closeMenu);
    menu.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); view.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); (document.activeElement === menuCode ? menuMarkdown : menuCode).focus(); }
    };
    dom.oncontextmenu = event => { event.preventDefault(); menu.hidden = false; menu.style.left = `${event.clientX}px`; menu.style.top = `${event.clientY}px`; menuCode.focus(); };
    controls.append(language, copy, copyMarkdown, menu); dom.append(controls, pre, diagram); draw();
    return { dom, contentDOM, update(next) { if (next.type !== node.type) return false; node = next; draw(); return true; },
      stopEvent: event => controls.contains(event.target as globalThis.Node),
      ignoreMutation: mutation => mutation.type !== 'selection' && !contentDOM.contains(mutation.target) && mutation.target !== contentDOM,
      destroy() { generation++; document.removeEventListener('click', closeMenu); } };
  });
  const image = $view(imageSchema.node, () => (initial) => {
    let node = initial;
    const dom = document.createElement('img');
    const draw = () => { dom.alt = node.attrs.alt ?? ''; dom.title = node.attrs.title ?? ''; resolveImage(node.attrs.src, dom); };
    draw();
    return { dom, update(next) { if (next.type !== node.type) return false; node = next; draw(); return true; } };
  });
  const item = $view(listItemSchema.node, () => (initial, view, getPos) => {
    let node = initial;
    const dom = document.createElement('li'), contentDOM = document.createElement('div'), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.contentEditable = 'false'; checkbox.setAttribute('aria-label', 'Task completed');
    const draw = () => { checkbox.hidden = node.attrs.checked == null; checkbox.checked = !!node.attrs.checked;
      dom.dataset.itemType = node.attrs.checked == null ? 'list' : 'task'; dom.dataset.checked = String(!!node.attrs.checked); };
    checkbox.onchange = () => { const pos = getPos(); if (pos !== undefined) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: checkbox.checked })); };
    dom.append(checkbox, contentDOM); draw();
    return { dom, contentDOM, update(next) { if (next.type !== node.type) return false; node = next; draw(); return true; },
      stopEvent: event => event.target === checkbox, ignoreMutation: mutation => mutation.type !== 'selection' && (mutation.target === checkbox || mutation.target === dom) };
  });
  return [$view(opaqueBlock, rawView(false)), $view(opaqueInline, rawView(true)), code, image, item];
}
