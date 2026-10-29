import { Plugin, TextSelection, Selection } from '@milkdown/kit/prose/state';
import { splitBlock, exitCode } from '@milkdown/kit/prose/commands';
import { splitListItem } from '@milkdown/kit/prose/schema-list';
import type { Ctx } from '@milkdown/kit/ctx';
import { parserCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node } from '@milkdown/kit/prose/model';
import { Fragment } from '@milkdown/kit/prose/model';
import { inlineMarkdownTrigger } from '../markdown';

export function autoMarkdown(ctx: Ctx, enabled: () => boolean, history: (direction: 'undo' | 'redo') => void): Plugin {
  const parse = (text: string) => ctx.get(parserCtx)(text);
  return new Plugin({ props: {
    handleKeyDown(view, event) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); history(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo'); return true;
      }
      const { $from, empty } = view.state.selection;
      if (!view.composing && !event.isComposing && empty && $from.parent.type.spec.code) {
        const after = $from.after(), next = view.state.doc.nodeAt(after);
        const atEnd = $from.parentOffset === $from.parent.content.size && (after === view.state.doc.content.size || (next?.type.name === 'paragraph' && !next.content.size));
        if ((event.key === 'Enter' && (event.ctrlKey || event.metaKey)) || (event.key === 'ArrowDown' && atEnd && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)) return continueAfterCode(view);
      }
      if (!enabled() || view.composing || event.isComposing || event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
      return commitOnEnter(view, parse);
    },
    handleTextInput(view, from, to, text) {
      if (!enabled() || view.composing) return false;
      const selection = view.state.doc.resolve(from), parent = selection.parent;
      if (parent.type.spec.code) return false;
      const plain = Array.from({ length: parent.childCount }, (_, i) => parent.child(i)).every(node => node.isText && !node.marks.length);
      if (plain && selection.parentOffset === parent.content.size && text === ' ') {
        const value = parent.textContent + text;
        if (/^\[(?: |x|X)\] $/.test(value)) {
          for (let depth = selection.depth - 1; depth > 0; depth--) {
            const item = selection.node(depth);
            if (item.type.name === 'list_item') {
              view.dispatch(view.state.tr.delete(selection.start(), to)
                .setNodeMarkup(selection.before(depth), undefined, { ...item.attrs, checked: value[1].toLowerCase() === 'x' }));
              return true;
            }
          }
        }
        if (/^(?:#{1,6}|[-+*]|\d+[.)]|>) $/.test(value)) {
          const parsed = parse(value);
          if (parsed.childCount) {
            const container = selection.node(selection.depth - 1), index = selection.index(selection.depth - 1);
            if (!container.canReplace(index, index + 1, parsed.content)) return false;
            const start = selection.before(), tr = view.state.tr.replaceWith(start, selection.after(), parsed.content);
            tr.setSelection(Selection.near(tr.doc.resolve(Math.min(start + parsed.nodeSize - 3, tr.doc.content.size)), -1));
            view.dispatch(tr); return true;
          }
        }
      }
      const before = selection.nodeBefore;
      const inherited = view.state.storedMarks ?? selection.marks();
      if (inherited.some(mark => mark.type.spec.code)) return false;
      const sameMarks = before?.marks.length === inherited.length && before.marks.every((mark, i) => mark.eq(inherited[i]));
      const prefix = before?.isText && sameMarks ? before.text! : '';
      const candidate = prefix + text;
      if (!inlineMarkdownTrigger(candidate)) return false;
      const parsed = parse(candidate);
      if (parsed.childCount !== 1 || parsed.firstChild?.type.name !== 'paragraph') return false;
      let content = parsed.firstChild.content;
      if (content.childCount === 1 && content.firstChild?.isText && !content.firstChild.marks.length) return false;
      if (inherited.length) {
        const children: Node[] = [];
        content.forEach(child => {
          let marks = child.marks;
          if (child.isText) for (const mark of inherited) if (!mark.type.isInSet(marks)) marks = mark.addToSet(marks);
          children.push(child.mark(marks));
        });
        content = Fragment.fromArray(children);
      }
      const start = from - prefix.length, tr = view.state.tr.replaceWith(start, to, content);
      tr.setSelection(TextSelection.create(tr.doc, start + content.size));
      view.dispatch(tr); return true;
    },
  } });
}

export function continueAfterCode(view: EditorView): boolean {
  const { $from } = view.state.selection;
  if (!$from.parent.type.spec.code) return false;
  const end = $from.after(), next = view.state.doc.nodeAt(end);
  if (next?.type.name === 'paragraph' && !next.content.size) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end + 1)).scrollIntoView());
    return true;
  }
  return exitCode(view.state, view.dispatch);
}

function commitOnEnter(view: EditorView, parse: (text: string) => Node): boolean {
  const { state } = view, { $from, empty } = state.selection;
  if (!empty || !$from.depth || $from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size) return false;
  const parent = $from.parent;
  let plain = true;
  parent.forEach(node => { if ((!node.isText && node.type.name !== 'hardbreak') || node.marks.length) plain = false; });
  if (!plain) return false;
  const raw = parent.textBetween(0, parent.content.size, '\n', '\n');
  if (!raw.trim()) return false;
  const parsed = parse(raw);
  if (!parsed.childCount || (parsed.childCount === 1 && parsed.firstChild?.eq(parent))) return false;
  const container = $from.node($from.depth - 1), index = $from.index($from.depth - 1);
  if (!container.canReplace(index, index + 1, parsed.content)) return false;
  const start = $from.before();
  const tr = state.tr.replaceWith(start, $from.after(), parsed.content);
  if (parsed.lastChild?.isAtom || parsed.lastChild?.type.name === 'table') {
    const end = start + parsed.content.size;
    const paragraph = state.schema.nodes.paragraph.create();
    if (tr.doc.resolve(end).parent.canReplace(tr.doc.resolve(end).index(), tr.doc.resolve(end).index(), Fragment.from(paragraph))) {
      tr.insert(end, paragraph); tr.setSelection(TextSelection.create(tr.doc, end + 1)); view.dispatch(tr); return true;
    }
  }
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(start + parsed.content.size - 1, tr.doc.content.size)), -1));
  view.dispatch(tr);
  if (parsed.firstChild?.type.spec.code) return true;
  const listItem = view.state.schema.nodes.list_item;
  if (listItem && splitListItem(listItem)(view.state, view.dispatch)) return true;
  splitBlock(view.state, view.dispatch);
  return true;
}
