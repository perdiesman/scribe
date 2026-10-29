import { markdownProcessor, parseMarkdown } from '../markdown';
import type { Root } from 'mdast';

interface AstNode {
  type: string; children?: AstNode[]; value?: string; identifier?: string;
  url?: string; title?: string | null; alt?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  [key: string]: unknown;
}

const supported = new Set(['root', 'paragraph', 'text', 'heading', 'emphasis', 'strong', 'delete',
  'inlineCode', 'link', 'image', 'blockquote', 'list', 'listItem', 'code', 'thematicBreak',
  'break', 'table', 'tableRow', 'tableCell']);

/** Keep unsupported syntax visible and editable instead of dropping it during a rich-text round trip. */
export function projectMarkdown(source: string): Root {
  const tree = parseMarkdown(source) as unknown as AstNode;
  const definitions = new Map((tree.children ?? []).filter(n => n.type === 'definition').map(n => [n.identifier, n]));
  function convert(node: AstNode, inline = false, top = false): AstNode {
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const definition = definitions.get(node.identifier);
      if (definition) return convert({ ...node, type: node.type === 'linkReference' ? 'link' : 'image', url: definition.url, title: definition.title }, inline);
    }
    const alert = node.type === 'blockquote' && /^\s*>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(
      source.slice(node.position?.start.offset, node.position?.end.offset));
    const containsHtml = (value: AstNode): boolean => value.type === 'html' || !!value.children?.some(containsHtml);
    if (!supported.has(node.type) || alert || (top && containsHtml(node))) {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      let value = start !== undefined && end !== undefined ? source.slice(start, end) : String(node.value ?? '');
      if (!inline && !top && node.type !== 'html') {
        value = markdownProcessor.stringify({ type: 'root', children: [node] } as unknown as Root).trimEnd();
      }
      return { type: inline ? 'scribeInline' : 'scribeBlock', value, kind: node.type };
    }
    const childInline = ['paragraph', 'heading', 'emphasis', 'strong', 'delete', 'link', 'tableCell'].includes(node.type);
    if (node.type === 'list' && node.ordered) node.children = node.children?.map((child, i) => ({ ...child, label: Number(node.start ?? 1) + i }));
    return { ...node, children: node.children?.map(child => convert(child, childInline, node.type === 'root')) };
  }
  return convert(tree) as unknown as Root;
}
