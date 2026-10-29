import type { Nodes } from 'mdast';
import { parseMarkdown } from '../markdown';

export function documentHeadings(source: string) {
  const headings: { text: string; level: number; line: number; offset: number }[] = [];
  const label = (node: Nodes): string => {
    if (node.type === 'html') return '';
    if (node.type === 'break') return ' ';
    if ('children' in node) return node.children.map(label).join('');
    if ('value' in node) return node.value;
    return node.type === 'image' || node.type === 'imageReference' ? node.alt ?? '' : '';
  };
  const visit = (node: Nodes) => {
    if (node.type === 'heading') headings.push({ text: label(node), level: node.depth, line: node.position!.start.line, offset: node.position!.start.offset! });
    if ('children' in node) node.children.forEach(visit);
  };
  visit(parseMarkdown(source));
  return headings;
}
