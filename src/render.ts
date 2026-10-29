import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { withoutFrontmatter } from './markdown';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { toHtml } from 'hast-util-to-html';
import hljs from 'highlight.js/lib/common';
import type { Root as MarkdownRoot, Blockquote, Text } from 'mdast';
import type { Root, Element, RootContent } from 'hast';
import type { Profile } from './protocol';

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]!);

function alerts() {
  return (tree: MarkdownRoot) => {
    function visit(node: MarkdownRoot | Blockquote | Record<string, unknown>) {
      if (node.type === 'blockquote') {
        const quote = node as Blockquote;
        const text = quote.children[0]?.type === 'paragraph' ? quote.children[0].children[0] : undefined;
        const match = text?.type === 'text' && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i.exec(text.value);
        if (match) {
          (text as Text).value = (text as Text).value.slice(match[0].length);
          quote.data = { hName: 'div', hProperties: { className: ['markdown-alert', `markdown-alert-${match[1].toLowerCase()}`] } };
          quote.children.unshift({ type: 'paragraph', data: { hProperties: { className: ['markdown-alert-title'] } },
            children: [{ type: 'text', value: match[1][0] + match[1].slice(1).toLowerCase() }] });
        }
      }
      if ('children' in node && Array.isArray(node.children)) node.children.forEach(child => visit(child as Record<string, unknown>));
    }
    visit(tree);
  };
}

function finishHtml() {
  return (tree: Root) => {
    const ids = new Set<string>();
    function collect(parent: Root | Element) {
      for (const child of parent.children) if (child.type === 'element') {
        if (child.properties.id) ids.add(String(child.properties.id)); collect(child);
      }
    }
    collect(tree);
    function visit(parent: Root | Element) {
      parent.children = parent.children.map(child => {
        if (child.type !== 'element') return child;
        if (child.tagName === 'a') {
          child.properties.rel = ['noopener', 'noreferrer'];
          const href = String(child.properties.href ?? '');
          if (href.startsWith('#') && !ids.has(href.slice(1)) && ids.has('user-content-' + href.slice(1))) child.properties.href = '#user-content-' + href.slice(1);
        }
        if (child.tagName === 'pre') {
          const code = child.children[0];
          if (code?.type === 'element' && code.tagName === 'code') {
            const language = (code.properties.className as string[] | undefined)?.find(c => c.startsWith('language-'))?.slice(9);
            const text = code.children.filter(n => n.type === 'text').map(n => n.value).join('');
            if (language === 'mermaid') return { type: 'element', tagName: 'div', properties: { className: ['mermaid'] },
              children: [{ type: 'text', value: text }] } as Element;
            if (language && hljs.getLanguage(language)) {
              const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
              // Highlight.js generates escaped markup from source, never executable document HTML.
              code.children = [{ type: 'raw', value: html } as unknown as RootContent] as Element['children'];
            }
          }
        }
        visit(child);
        return child;
      });
    }
    visit(tree);
  };
}

export function renderMarkdown(source: string, profile: Profile = 'github'): string {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
    .use(alerts)
    .use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw)
    .use(rehypeSanitize, {
      ...defaultSchema,
      attributes: { ...defaultSchema.attributes,
        '*': [...(defaultSchema.attributes?.['*'] ?? []), ['className', /^markdown-alert(?:-[a-z]+)?$/]],
        code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-./, 'math-inline', 'math-display']],
        div: [['className', 'math', 'math-display', /^markdown-alert(?:-[a-z]+)?$/]],
      },
    }).use(rehypeKatex, { trust: false, strict: 'ignore' })
    .use(finishHtml);
  const input = withoutFrontmatter(source);
  const tree = processor.runSync(processor.parse(input));
  return `<article class="markdown-body profile-${profile}">${toHtml(tree, { allowDangerousHtml: true })}</article>`;
}
