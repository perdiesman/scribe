import mermaid from 'mermaid';

let theme: 'dark' | 'neutral' | undefined;
const currentTheme = () => !document.body.classList.contains('export') && (document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast')) ? 'dark' : 'neutral';

export async function enhance(root: ParentNode = document): Promise<void> {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('.mermaid:not([data-processed])'));
  for (const node of nodes) {
    const source = node.dataset.mermaidSource ?? node.textContent ?? ''; node.dataset.mermaidSource = source;
    if (!node.isConnected) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (!node.isConnected || !node.getClientRects().length) continue;
    if (theme !== currentTheme()) {
      theme = currentTheme(); mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, suppressErrorRendering: true, maxTextSize: 50_000 });
    }
    try { await mermaid.run({ nodes: [node] }); if (!node.querySelector('svg')) throw new Error('No diagram was generated.'); }
    catch {
      node.dataset.processed = 'true'; node.classList.add('render-error');
      node.textContent = 'Unable to render Mermaid diagram. Edit its source to correct it.\n\n' + source;
    }
  }
}

new MutationObserver(() => {
  if (theme === currentTheme()) return;
  for (const node of document.querySelectorAll<HTMLElement>('.mermaid[data-mermaid-source]')) {
    node.textContent = node.dataset.mermaidSource!; node.removeAttribute('data-processed'); node.classList.remove('render-error');
  }
  void enhance();
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

if (document.documentElement.dataset.scribeExport === 'true') {
  (window as unknown as { scribeReady: Promise<void> }).scribeReady = enhance().then(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map(image => image.complete ? Promise.resolve() :
      new Promise<void>(resolve => { image.onload = image.onerror = () => resolve(); })));
  });
}
