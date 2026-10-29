import { icon, type Icon } from './icons';
import type { SourceFormat } from './source';
import type { EditorMode, Profile, Settings } from '../protocol';

export type TableAction = 'insert' | 'row' | 'column' | 'deleteRow' | 'deleteColumn' | 'delete';
export function buildToolbar(toolbar: HTMLElement, settings: Settings, mode: EditorMode, actions: {
  format: (action: SourceFormat, value?: string) => void;
  table: (action: TableAction) => void;
  link: () => void; image: () => void; mode: (mode: EditorMode) => void;
  command: (command: 'auto' | 'normalize' | 'html' | 'pdf') => void;
  profile: (profile: Profile) => void;
  toc: () => void; tocVisible: boolean;
}) {
  const readOnly = mode === 'preview';
  const focused = toolbar.contains(document.activeElement) ? document.activeElement?.getAttribute('aria-label') : null;
  toolbar.replaceChildren();
  const button = (name: Icon, label: string, action: () => void, editing = true) => {
    const element = document.createElement('button'); element.type = 'button'; element.className = 'icon-button';
    element.title = label; element.setAttribute('aria-label', label); element.dataset.toolbar = '';
    element.disabled = readOnly && editing;
    element.append(icon(name)); element.onmousedown = event => event.preventDefault(); element.onclick = action;
    toolbar.append(element); return element;
  };
  const separator = () => { const divider = document.createElement('span'); divider.className = 'toolbar-separator'; divider.setAttribute('role', 'separator'); toolbar.append(divider); };
  const menu = (name: Icon, label: string, entries: [string, () => void][]) => {
    const details = document.createElement('details'); details.className = 'toolbar-menu';
    const summary = document.createElement('summary'); summary.title = label; summary.setAttribute('aria-label', label); summary.setAttribute('aria-haspopup', 'menu'); summary.dataset.toolbar = ''; summary.append(icon(name));
    summary.setAttribute('aria-disabled', String(readOnly)); summary.onclick = event => { if (readOnly) event.preventDefault(); };
    summary.onmousedown = event => { if (readOnly) event.preventDefault(); };
    const popup = document.createElement('div'); popup.className = 'toolbar-popup'; popup.setAttribute('role', 'menu');
    for (const [label, action] of entries) {
      const item = document.createElement('button'); item.type = 'button'; item.textContent = label; item.title = label; item.setAttribute('role', 'menuitem');
      item.disabled = readOnly;
      item.onmousedown = event => event.preventDefault(); item.onclick = () => { details.open = false; action(); }; popup.append(item);
    }
    popup.onkeydown = event => {
      const items = Array.from(popup.querySelectorAll('button'));
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    };
    summary.onkeydown = event => { if (readOnly) { if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) event.preventDefault(); return; } if (event.key === 'ArrowDown') { event.preventDefault(); details.open = true; (popup.firstElementChild as HTMLElement).focus(); } };
    details.addEventListener('toggle', () => {
      if (!details.open) return; popup.style.left = '0'; popup.style.right = 'auto';
      if (popup.getBoundingClientRect().right > window.innerWidth - 8) { popup.style.left = 'auto'; popup.style.right = '0'; }
    });
    details.append(summary, popup); toolbar.append(details);
  };
  const toc = button('toc', 'Toggle table of contents', actions.toc, false);
  toc.setAttribute('aria-controls', 'toc'); toc.setAttribute('aria-expanded', String(actions.tocVisible));
  toc.setAttribute('aria-pressed', String(actions.tocVisible));
  separator();
  menu('heading', 'Paragraph or heading', ['Paragraph', ...Array.from({ length: 6 }, (_, i) => `Heading ${i + 1}`)].map((label, i) => [label, () => actions.format('heading', String(i))]));
  for (const [name, action, label] of [
    ['bold', 'strong', 'Bold (Ctrl/Cmd+B)'], ['italic', 'emphasis', 'Italic (Ctrl/Cmd+I)'], ['strike', 'strike', 'Strikethrough (Ctrl/Cmd+Shift+X)'], ['inlineCode', 'inlineCode', 'Inline code (Ctrl/Cmd+E)'],
  ] as const) button(name, label, () => actions.format(action));
  const link = button('link', 'Insert or edit link (Ctrl/Cmd+K)', actions.link); link.dataset.shortcut = 'link';
  button('image', 'Insert image', actions.image);
  separator();
  for (const [name, action, label] of [
    ['bullet', 'bullet', 'Bullet list'], ['ordered', 'ordered', 'Numbered list'], ['task', 'task', 'Task list'], ['quote', 'quote', 'Block quote'], ['code', 'code', 'Code block'],
  ] as const) button(name, label, () => actions.format(action));
  menu('table', 'Table actions', [
    ['Insert table', () => actions.table('insert')], ['Add row', () => actions.table('row')], ['Add column', () => actions.table('column')],
    ['Delete row', () => actions.table('deleteRow')], ['Delete column', () => actions.table('deleteColumn')], ['Delete table', () => actions.table('delete')],
  ]);
  button('outdent', 'Outdent', () => actions.format('outdent')); button('indent', 'Indent', () => actions.format('indent'));
  separator();
  const auto = button('auto', 'Toggle automatic Markdown formatting', () => actions.command('auto'));
  auto.title = `Auto Markdown: ${settings.autoFormatMarkdown ? 'On' : 'Off'} (visual editor)`; auto.setAttribute('aria-pressed', String(settings.autoFormatMarkdown));
  const profile = document.createElement('select'); profile.title = 'Rendering profile'; profile.setAttribute('aria-label', profile.title); profile.dataset.toolbar = '';
  profile.add(new Option('GitHub', 'github')); profile.add(new Option('GitLab', 'gitlab')); profile.value = settings.profile;
  profile.onchange = () => actions.profile(profile.value as Profile); toolbar.append(profile);
  separator();
  for (const [name, value, label] of [['visual', 'wysiwyg', 'WYSIWYG view'], ['source', 'source', 'Source view'], ['split', 'split', 'Split view'], ['preview', 'preview', 'Read-only preview']] as const) {
    button(name, label, () => actions.mode(value), false).setAttribute('aria-pressed', String(mode === value));
  }
  separator();
  button('normalize', 'Normalize Document (undoable)', () => actions.command('normalize'));
  button('html', 'Export HTML', () => actions.command('html'), false); button('pdf', 'Export PDF', () => actions.command('pdf'), false);
  const allControls = Array.from(toolbar.querySelectorAll<HTMLElement>('[data-toolbar]'));
  allControls.forEach(control => { control.tabIndex = -1; });
  const controls = allControls.filter(control => !(control instanceof HTMLButtonElement && control.disabled) && control.getAttribute('aria-disabled') !== 'true');
  const focus = Math.max(0, controls.findIndex(control => control.getAttribute('aria-label') === focused));
  controls.forEach((control, i) => { control.tabIndex = i === focus ? 0 : -1; }); if (focused) controls[focus]?.focus();
  toolbar.onkeydown = event => {
    if (event.key === 'Escape') {
      const open = toolbar.querySelector<HTMLDetailsElement>('details[open]');
      if (open) { open.open = false; open.querySelector('summary')?.focus(); event.preventDefault(); } return;
    }
    if ((event.target as HTMLElement).closest('[role=menu]') || event.target instanceof HTMLSelectElement || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const current = controls.indexOf(document.activeElement as HTMLElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length;
    controls.forEach((control, i) => { control.tabIndex = i === index ? 0 : -1; }); controls[index].focus();
  };
}

document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('details.toolbar-menu[open]')) if (!menu.contains(event.target as Node)) menu.open = false;
});
