import mermaid from 'mermaid';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral',
  suppressErrorRendering: true, maxTextSize: 50_000 });

export async function enhance(root: ParentNode = document): Promise<void> {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('.mermaid:not([data-processed])'));
  for (const node of nodes) {
    try { await mermaid.run({ nodes: [node] }); }
    catch { node.removeAttribute('data-processed'); node.classList.add('render-error'); node.title = 'Invalid Mermaid diagram. Edit its source to correct it.'; }
  }
}

if (document.documentElement.dataset.scribeExport === 'true') {
  (window as unknown as { scribeReady: Promise<void> }).scribeReady = enhance().then(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map(image => image.complete ? Promise.resolve() :
      new Promise<void>(resolve => { image.onload = image.onerror = () => resolve(); })));
  });
}
