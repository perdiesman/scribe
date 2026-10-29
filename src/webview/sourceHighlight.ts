import hljs from 'highlight.js/lib/common';
import markdown from 'highlight.js/lib/languages/markdown';
import type { Mode } from 'highlight.js';

hljs.registerLanguage('scribe-markdown', api => {
  const language = markdown(api);
  // Recognize math before emphasis so TeX subscripts cannot open Markdown italics.
  const contents: Mode[] = [{ scope: 'keyword', match: /\\[A-Za-z]+/ }, api.BACKSLASH_ESCAPE];
  const math: Mode[] = [
    { match: /\\\$/, relevance: 0 },
    { scope: 'formula', begin: /\$\$/, end: /\$\$/, contains: contents, relevance: 0 },
    { scope: 'formula', begin: /\$(?![\s$])/, end: /\$|$/, contains: contents, relevance: 0 },
  ];
  const visited = new Set<Mode>();
  const inlineClass = (mode: Mode) => ['section', 'strong', 'emphasis', 'quote'].includes(mode.className ?? '');
  const extend = (mode: Mode, parentInline = false) => {
    if (visited.has(mode)) return; visited.add(mode);
    const inline = parentInline || inlineClass(mode) || mode.contains?.some(child => child !== 'self' && inlineClass(child));
    mode.contains?.forEach(child => { if (child !== 'self') extend(child); });
    mode.variants?.forEach(variant => extend(variant, inline));
    if (inline) mode.contains = [...math, ...(mode.contains ?? [])];
  };
  language.contains?.forEach(mode => extend(mode));
  return { ...language, aliases: [], contains: [...math, ...(language.contains ?? [])] };
});

export function highlightMarkdownSource(source: string): string {
  return hljs.highlight(source, { language: 'scribe-markdown', ignoreIllegals: true }).value;
}
