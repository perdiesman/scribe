const paths = {
  bold: 'M6 4h7a4 4 0 0 1 0 8H6zm0 8h8a4 4 0 0 1 0 8H6z',
  italic: 'M10 4h10M4 20h10M15 4 9 20',
  strike: 'M17 5c-5-4-12-1-9 4M7 17c2 4 11 4 10-1M3 12h18',
  inlineCode: 'm8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16',
  heading: 'M5 4v16M17 4v16M5 12h12',
  link: 'm10 13 4-4M9 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  image: 'M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M16 7h.01',
  bullet: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  ordered: 'M10 6h11M10 12h11M10 18h11M3 4h1v5M2 13c3-2 5 1 2 3l-2 2h4',
  task: 'M9 5h12M9 12h12M9 19h12m-19-7 2 2 3-4M2 3h3v3H2zM2 17h3v3H2z',
  quote: 'M4 6h6v8H4zm10 0h6v8h-6zM10 14c0 4-2 5-4 5m14-5c0 4-2 5-4 5',
  code: 'M3 3h18v18H3zm5 5-4 4 4 4m8-8 4 4-4 4',
  table: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  indent: 'M10 5h11M10 12h11M10 19h11m-18-9 4 3-4 3',
  outdent: 'M10 5h11M10 12h11M10 19h11m-14-9-4 3 4 3',
  auto: 'm4 20 12-12 3 3L7 23M5 2v6M2 5h6M18 1v4M16 3h4M20 15v6M17 18h6',
  visual: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm7 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
  preview: 'M2 9s4-6 10-6 10 6 10 6l-3 3M2 9l3 3m4-3a3 3 0 1 0 6 0 3 3 0 1 0-6 0M9 15h8v7H9zm2 0v-2a2 2 0 0 1 4 0v2',
  copy: 'M8 8h13v13H8zM16 8V3H3v13h5',
  source: 'm8 5-6 7 6 7m8-14 6 7-6 7',
  split: 'M3 3h18v18H3zM12 3v18M6 7h3M6 11h3M15 7h3M15 11h3',
  normalize: 'M4 5h16M4 10h10M4 15h6m4 2 3 3 5-7',
  html: 'M5 2h9l5 5v15H5zM14 2v6h5m-9 4-3 3 3 3m4-6 3 3-3 3',
  pdf: 'M5 2h9l5 5v15H5zM14 2v6h5M12 11v8m-3-3 3 3 3-3',
  exit: 'M5 3v12h13m-4-4 4 4-4 4',
} as const;

export type Icon = keyof typeof paths;
export function icon(name: Icon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<path d="${paths[name]}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`;
  return svg;
}
