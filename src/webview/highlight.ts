import hljs from 'highlight.js/lib/common';
import { Plugin } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { Node } from '@milkdown/kit/prose/model';

function decorations(doc: Node) {
  const result: Decoration[] = [];
  doc.descendants((node, position) => {
    const language = node.attrs.language;
    if (node.type.name !== 'code_block' || !language || !hljs.getLanguage(language)) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = hljs.highlight(node.textContent, { language, ignoreIllegals: true }).value;
    let offset = position + 1;
    function visit(parent: globalThis.Node) {
      for (const child of parent.childNodes) {
        const start = offset;
        if (child.nodeType === globalThis.Node.TEXT_NODE) offset += child.textContent?.length ?? 0;
        else visit(child);
        if (child instanceof HTMLElement && child.className && offset > start) result.push(Decoration.inline(start, offset, { class: child.className }));
      }
    }
    visit(wrapper);
  });
  return DecorationSet.create(doc, result);
}

export const highlighting = () => new Plugin<DecorationSet>({
  state: { init: (_, state) => decorations(state.doc), apply: (transaction, previous) => transaction.docChanged ? decorations(transaction.doc) : previous },
  props: { decorations(state) { return this.getState(state); } },
});
