import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkStringify from 'remark-stringify';
import type { Root, RootContent } from 'mdast';

export const markdownProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
  .use(remarkStringify, {
    bullet: '-', emphasis: '*', strong: '*', fences: true, listItemIndent: 'one',
    rule: '-', ruleRepetition: 3,
  });

function frontmatter(source: string) {
  const opening = /^(?:\uFEFF)?(---|\+\+\+)[ \t]*\r?\n/.exec(source);
  if (!opening) return;
  const close = new RegExp(`^${opening[1].replace(/\+/g, '\\+')}[ \\t]*(?=\\r?$)`, 'm').exec(source.slice(opening[0].length));
  if (!close) return;
  const end = opening[0].length + close.index + close[0].length;
  return { end, type: opening[1] === '---' ? 'yaml' : 'toml' };
}

export function withoutFrontmatter(source: string): string {
  const metadata = frontmatter(source);
  return metadata ? source.slice(0, metadata.end).replace(/[^\r\n]/g, ' ') + source.slice(metadata.end) : source;
}

export function parseMarkdown(source: string): Root {
  const tree = markdownProcessor.parse(withoutFrontmatter(source)) as Root;
  const metadata = frontmatter(source);
  if (metadata) {
    const lines = source.slice(0, metadata.end).split(/\r?\n/);
    tree.children.unshift({ type: metadata.type, value: source.slice(0, metadata.end),
      position: { start: { line: 1, column: 1, offset: 0 }, end: { line: lines.length, column: lines.at(-1)!.length + 1, offset: metadata.end } },
    } as unknown as RootContent);
  }
  return tree;
}

export function normalizeMarkdown(source: string): string {
  const tree = parseMarkdown(source);
  // Preserve raw/unknown constructs even when the surrounding document is normalized.
  tree.children = tree.children.map(node => {
    if (['yaml', 'toml', 'html'].includes(node.type)) {
      return { type: 'html', value: source.slice(node.position!.start.offset, node.position!.end.offset) };
    }
    return node;
  });
  return withLineEnding(markdownProcessor.stringify(tree), lineEnding(source));
}

export function lineEnding(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

export function withLineEnding(source: string, eol: string): string {
  return source.replace(/\r?\n/g, eol);
}

export function sourceBlocks(source: string) {
  return parseMarkdown(source).children.map(node => ({
    start: node.position!.start.offset!, end: node.position!.end.offset!,
    line: node.position!.start.line - 1, endLine: node.position!.end.line - 1,
  }));
}

function signatures(tree: Root): string[] {
  const definitions = new Map(tree.children.filter(n => n.type === 'definition').map(n => [n.identifier, n]));
  function clean(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    let node = value as Record<string, unknown>;
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const def = definitions.get(String(node.identifier));
      if (def) node = { type: node.type === 'linkReference' ? 'link' : 'image',
        url: def.url, title: def.title ?? null, ...(node.type === 'linkReference'
          ? { children: node.children } : { alt: node.alt }) };
    }
    if (node.type === 'link' || node.type === 'image') node = { ...node, title: node.title || null, ...(node.type === 'image' ? { alt: node.alt || '' } : {}) };
    return Object.fromEntries(Object.keys(node).sort()
      .filter(key => !['position', 'data', 'spread'].includes(key))
      .map(key => [key, clean(node[key])]));
  }
  return tree.children.map(node => JSON.stringify(clean(node)));
}

/** Match semantic blocks while retaining their exact original source and separators. */
export function preserveMarkdown(original: string, serialized: string): string {
  const oldTree = parseMarkdown(original), newTree = parseMarkdown(serialized);
  const oldKeys = signatures(oldTree), newKeys = signatures(newTree);
  if (oldKeys.length === newKeys.length && oldKeys.every((key, i) => key === newKeys[i])) return original;
  const oldNodes = oldTree.children, newNodes = newTree.children;
  // Monotonic anchors keep duplicate blocks in order without a quadratic diff matrix.
  const positions = new Map<string, number[]>();
  oldKeys.forEach((key, i) => { const list = positions.get(key) ?? []; list.push(i); positions.set(key, list); });
  const matches = new Map<number, number>();
  let previous = -1;
  newKeys.forEach((key, i) => {
    const index = positions.get(key)?.find(index => index > previous);
    if (index !== undefined) { matches.set(i, index); previous = index; }
  });
  const eol = lineEnding(original);
  const slice = (text: string, node: RootContent) => text.slice(node.position!.start.offset, node.position!.end.offset);
  let result = original.slice(0, oldNodes[0]?.position?.start.offset ?? 0);
  newNodes.forEach((node, i) => {
    const oldIndex = matches.get(i), prior = matches.get(i - 1);
    if (i > 0) result += oldIndex !== undefined && prior !== undefined && oldIndex === prior + 1
      ? original.slice(oldNodes[prior].position!.end.offset, oldNodes[oldIndex].position!.start.offset)
      : eol + eol;
    result += oldIndex === undefined ? withLineEnding(slice(serialized, node), eol) : slice(original, oldNodes[oldIndex]);
  });
  const trailing = oldNodes.length ? original.slice(oldNodes.at(-1)!.position!.end.offset) : '';
  return result + trailing;
}

export interface TextPatch { start: number; end: number; text: string }
export function minimalPatch(before: string, after: string): TextPatch | undefined {
  if (before === after) return;
  let start = 0, end = before.length, afterEnd = after.length;
  while (start < end && start < afterEnd && before[start] === after[start]) start++;
  while (end > start && afterEnd > start && before[end - 1] === after[afterEnd - 1]) { end--; afterEnd--; }
  // Do not split a UTF-16 surrogate pair or CRLF across a patch boundary.
  if (start && /[\uD800-\uDBFF\r]/.test(before[start - 1])) start--;
  return { start, end, text: after.slice(start, afterEnd) };
}

export function fencedCode(code: string, language = ''): string {
  const runs = code.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return `${fence}${language.replace(/[\r\n`]/g, '')}\n${code}\n${fence}`;
}

export function inlineMarkdownTrigger(value: string): boolean {
  return [
    /(?<!\*)\*{3}[^*]+\*{3}$/, /(?<!_)_{3}[^_]+_{3}$/,
    /(?<!\*)\*\*[^*]+\*\*$/, /(?<!_)__[^_]+__$/,
    /(?<!\*)\*[^*]+\*$/, /(?<!_)_[^_]+_$/,
    /(?<!~)~~[^~]+~~$/, /(?<!`)(`+)[^`].*\1$/,
    /!?\[[^\]]*\]\([^)]*\)$/, /(?<!\$)(\${1,2})[^$].*\1$/,
  ].some(pattern => pattern.test(value));
}
