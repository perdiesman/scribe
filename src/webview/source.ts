import { fencedCode } from '../markdown';

export type SourceFormat = 'strong' | 'emphasis' | 'strike' | 'inlineCode' | 'heading' | 'bullet' | 'ordered' | 'task' | 'quote' | 'code' | 'indent' | 'outdent' | 'link' | 'image';

export function formatSource(source: string, start: number, end: number, action: SourceFormat, value = '', label = '') {
  const selected = source.slice(start, end);
  const markers = { strong: '**', emphasis: '*', strike: '~~', inlineCode: '`' };
  if (action in markers) {
    const marker = markers[action as keyof typeof markers];
    if (source.slice(start - marker.length, start) === marker && source.slice(end, end + marker.length) === marker) {
      return { from: start - marker.length, to: end + marker.length, text: selected, start: start - marker.length, end: end - marker.length };
    }
    const text = selected || 'text';
    return { from: start, to: end, text: marker + text + marker, start: start + marker.length, end: start + marker.length + text.length };
  }
  if (action === 'link' || action === 'image') {
    const text = (action === 'image' ? label : selected || 'link text').replace(/[\[\]\\]/g, '\\$&');
    const url = value.replace(/[\s()]/g, char => encodeURIComponent(char));
    const markdown = `${action === 'image' ? '!' : ''}[${text}](${url})`;
    return { from: start, to: end, text: markdown, start: start + markdown.length, end: start + markdown.length };
  }
  if (action === 'code') {
    const text = fencedCode(selected, value);
    const before = start && source[start - 1] !== '\n' ? '\n\n' : '';
    const after = source[end] && source[end] !== '\n' ? '\n\n' : '';
    const cursor = start + before.length + text.indexOf('\n') + 1;
    return { from: start, to: end, text: before + text + after, start: cursor, end: cursor + selected.length };
  }
  const from = start === 0 ? 0 : source.lastIndexOf('\n', start - 1) + 1;
  const next = source.indexOf('\n', Math.max(start, end - (source[end - 1] === '\n' ? 1 : 0)));
  const to = next < 0 ? source.length : next;
  const lines = source.slice(from, to).split('\n').map((line, i) => {
    switch (action) {
      case 'heading': return (Number(value) ? '#'.repeat(Number(value)) + ' ' : '') + line.replace(/^#{1,6}\s+/, '');
      case 'bullet': return '- ' + line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '');
      case 'ordered': return `${i + 1}. ` + line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '');
      case 'task': return '- [ ] ' + line.replace(/^\s*(?:[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '');
      case 'quote': return '> ' + line.replace(/^>\s?/, '');
      case 'indent': return '  ' + line;
      case 'outdent': return line.replace(/^(?: {1,2}|\t)/, '');
      default: return line;
    }
  });
  const text = lines.join('\n');
  return { from, to, text, start: from, end: from + text.length };
}
