import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function open(page: Page, source = '') {
  const id = randomUUID();
  await page.request.post(`/reset?id=${id}`, { data: { source } });
  await page.goto(`/?id=${id}`);
  await expect(page.getByRole('textbox', { name: 'Markdown document' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Saved');
  return { id, state: async () => (await page.request.get(`/state?id=${id}`)).json() };
}

test('Enter converts typed Markdown and shortcuts convert headings and emphasis', async ({ page }) => {
  await open(page);
  const editor = page.getByRole('textbox', { name: 'Markdown document' });
  await editor.pressSequentially('# Heading');
  await expect(editor.locator('h1')).toHaveText('Heading');
  await editor.press('Enter');
  await expect(editor.locator('h1')).toHaveText('Heading');
  await editor.pressSequentially('**Bold**');
  await expect(editor.locator('strong')).toHaveText('Bold');
  await editor.press('Enter');
  await editor.pressSequentially('```js');
  await editor.press('Enter');
  await expect(editor.locator('.code-block')).toBeVisible();
  await editor.pressSequentially('const x = 1;');
  await editor.press('Enter');
  await editor.pressSequentially('# literal code');
  await expect(editor.locator('pre')).toContainText('const x = 1;\n# literal code');
});

test('Auto Markdown off keeps all typed syntax literal and persists across reload', async ({ page }) => {
  const { state } = await open(page);
  const toggle = page.getByRole('button', { name: /Toggle automatic Markdown/ });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const editor = page.getByRole('textbox', { name: 'Markdown document' });
  await editor.click(); await editor.pressSequentially('# Literal **bold**'); await editor.press('Enter');
  await expect(editor.locator('h1,strong')).toHaveCount(0);
  await expect(editor).toContainText('# Literal **bold**');
  await expect.poll(async () => (await state()).source).toContain('Literal');
  await page.reload(); await expect(page.getByRole('button', { name: /Toggle automatic Markdown/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.ProseMirror h1,strong')).toHaveCount(0);
});

test('toggling never edits the document and preserves existing rich formatting', async ({ page }) => {
  const source = '# Existing\n\n**Bold** text.\n';
  const { state } = await open(page, source);
  await page.getByRole('button', { name: /Toggle automatic Markdown/ }).click();
  await expect(page.locator('.ProseMirror h1')).toHaveText('Existing');
  await expect(page.locator('.ProseMirror strong')).toHaveText('Bold');
  expect((await state()).source).toBe(source);
});

test('focused edits preserve untouched Markdown and normalization is undoable', async ({ page }) => {
  const { state } = await open(page, 'Title\n=====\n\n*   Keep\n\nEdit me.\n');
  const editor = page.getByRole('textbox', { name: 'Markdown document' });
  await editor.locator('p').last().click(); await editor.press('End'); await editor.pressSequentially(' Changed.');
  await expect.poll(async () => (await state()).source).toContain('Changed.');
  expect((await state()).source).toMatch(/^Title\n=====\n\n\*   Keep/);
  await page.getByRole('button', { name: 'Normalize Document (undoable)' }).click();
  await expect.poll(async () => (await state()).source).toMatch(/^# Title\n\n- Keep/);
  await editor.click(); await editor.press('ControlOrMeta+z');
  await expect.poll(async () => (await state()).source).toMatch(/^Title\n=====/);
});

test('code buttons copy exact code and fenced Markdown', async ({ page }) => {
  const { state } = await open(page, '```js\nconst x = 1;\n```\n');
  await page.getByRole('button', { name: 'Copy Code', exact: true }).click();
  await expect.poll(async () => (await state()).copies[0]).toBe('const x = 1;');
  await page.getByRole('button', { name: 'Copy Markdown', exact: true }).click();
  await expect.poll(async () => (await state()).copies[1]).toBe('```js\nconst x = 1;\n```');
});

test('unsafe HTML is inert, while math and diagrams render', async ({ page }) => {
  await open(page, '<img src="x" onerror="window.compromised=true">\n\n$x^2$\n\n```mermaid\ngraph TD; A-->B\n```\n');
  await expect(page.locator('.katex')).toBeVisible();
  await expect(page.locator('.diagram-preview svg')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { compromised?: boolean }).compromised)).toBeUndefined();
});

test('a concurrent source update preserves pending visual edits for recovery', async ({ page }) => {
  const { id, state } = await open(page, 'Original');
  const editor = page.getByRole('textbox', { name: 'Markdown document' });
  await editor.click(); await editor.press('End');
  await page.route('**/message?*', async route => {
    const message = route.request().postDataJSON();
    if (message.type === 'edit') {
      const response = await page.request.post(`/reset?id=${id}`, { data: { source: 'External source' } });
      await route.fulfill({ json: [await response.json()] });
    } else await route.continue();
  });
  await page.keyboard.insertText(' visual');
  await expect.poll(async () => (await state()).recoveries.length).toBeGreaterThan(0);
  expect((await state()).recoveries.join('\n')).toContain('visual');
});

test('source and split stay in one editor with formatting, export controls, and save status', async ({ page }) => {
  const { state } = await open(page, 'Original');
  await page.getByRole('button', { name: 'Source view', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source', exact: true });
  await expect(source).toHaveValue('Original');
  await source.fill('hello'); await source.press('ControlOrMeta+a'); await source.press('ControlOrMeta+b');
  await expect(source).toHaveValue('**hello**');
  await source.press('ControlOrMeta+b'); await expect(source).toHaveValue('hello');
  await source.press('ControlOrMeta+i'); await expect(source).toHaveValue('*hello*');
  await expect(page.getByRole('status')).toHaveText('Unsaved changes');
  await source.press('ControlOrMeta+s'); await expect(page.getByRole('status')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Split view', exact: true }).click();
  await expect(source).toBeVisible(); await expect(page.getByRole('textbox', { name: 'Markdown document' })).toBeVisible();
  await expect(page.locator('.ProseMirror em')).toHaveText('hello');
  expect(page.context().pages().length).toBe(1);
  await page.getByRole('button', { name: 'Export HTML', exact: true }).click();
  await expect.poll(async () => (await state()).commands).toContain('html');
  await page.reload(); await expect(page.getByRole('textbox', { name: 'Markdown source', exact: true })).toBeVisible();
});

test('toolbar icons have tooltips, table actions share one menu, and the logo loads', async ({ page }) => {
  await open(page);
  for (const control of await page.locator('#toolbar [data-toolbar]').all()) expect(await control.getAttribute('title')).toBeTruthy();
  await expect(page.locator('#toolbar > button:not(:has(svg))')).toHaveCount(0);
  const logo = page.getByRole('img', { name: 'SCRIBE logo' });
  await expect.poll(() => logo.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.locator('summary[aria-label="Table actions"]').click();
  await expect(page.getByRole('menuitem', { name: 'Add row', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Insert table', exact: true }).click();
  await expect(page.locator('.ProseMirror table')).toBeVisible();
});

for (const method of ['arrow', 'shortcut', 'click'] as const) test(`write after a final code block using ${method}`, async ({ page }) => {
  await open(page, '```js\nconst x = 1;\n```');
  const editor = page.getByRole('textbox', { name: 'Markdown document' });
  if (method === 'click') await editor.locator(':scope > p:last-child').click();
  else {
    await editor.locator('pre code').click(); await page.keyboard.press('End');
    await page.keyboard.press(method === 'arrow' ? 'ArrowDown' : 'ControlOrMeta+Enter');
  }
  await page.keyboard.type('After the block');
  await expect(editor.locator('pre code')).toHaveText('const x = 1;');
  await expect(editor.locator('p').last()).toHaveText('After the block');
});

test('visual keyboard shortcuts toggle formatting and menus follow the dark theme', async ({ page }) => {
  await open(page, 'Text');
  const editor = page.getByRole('textbox', { name: 'Markdown document' });
  await editor.click(); await editor.press('ControlOrMeta+a'); await editor.press('ControlOrMeta+b');
  await expect(editor.locator('strong')).toHaveText('Text');
  await editor.press('ControlOrMeta+b'); await expect(editor.locator('strong')).toHaveCount(0);
  await editor.press('ControlOrMeta+i'); await expect(editor.locator('em')).toHaveText('Text');
  await page.evaluate(() => {
    document.body.classList.add('vscode-dark');
    document.body.style.setProperty('--vscode-menu-background', '#252526'); document.body.style.setProperty('--vscode-menu-foreground', '#cccccc');
    document.body.style.setProperty('--vscode-dropdown-background', '#3c3c3c'); document.body.style.setProperty('--vscode-dropdown-foreground', '#f0f0f0');
  });
  await page.locator('summary[aria-label="Paragraph or heading"]').click();
  await expect(page.getByRole('menu')).toHaveCSS('color', 'rgb(204, 204, 204)');
  await expect(page.getByRole('menu')).toHaveCSS('background-color', 'rgb(37, 37, 38)');
  await expect(page.locator('select option').first()).toHaveCSS('color', 'rgb(240, 240, 240)');
});

test('diagrams render after returning from source editing and invalid diagrams show a useful error', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Source view', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source', exact: true });
  await source.fill('```mermaid\nflowchart LR\n A --> B\n```');
  await page.getByRole('button', { name: 'Split view', exact: true }).click();
  await expect(page.locator('.diagram-preview svg')).toBeVisible();
  await source.fill('```mermaid\nnot-a-valid-diagram\n```');
  await expect(page.locator('.diagram-preview .render-error')).toContainText('Unable to render Mermaid diagram');
});

test('branding and toolbar share a row when wide and wrap without overflow when narrow', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 }); await open(page);
  const brand = page.locator('.brand'), toolbar = page.getByRole('toolbar', { name: 'Markdown editing' });
  let branding = (await brand.boundingBox())!, tools = (await toolbar.boundingBox())!;
  expect(tools.y).toBeLessThan(branding.y + branding.height); expect(tools.x).toBeGreaterThanOrEqual(branding.x + branding.width);
  await page.setViewportSize({ width: 420, height: 800 });
  await expect.poll(async () => {
    branding = (await brand.boundingBox())!; tools = (await toolbar.boundingBox())!;
    return tools.y >= branding.y + branding.height;
  }).toBe(true);
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
});

test('source syntax colors update in both source modes and follow two-axis scrolling', async ({ page }) => {
  const text = '# Heading\n\n**bold** and *italic*\n\n' + Array.from({ length: 80 }, (_, i) => `- Row ${i}: ` + 'text '.repeat(60)).join('\n');
  await open(page, text); await page.getByRole('button', { name: 'Source view', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source', exact: true });
  await expect(page.locator('#source-highlight .hljs-section')).toHaveText('# Heading');
  await expect(page.locator('#source-highlight .hljs-strong')).toHaveText('**bold**');
  await page.getByRole('button', { name: 'Split view', exact: true }).click();
  await source.evaluate(element => { element.scrollTop = 180; element.scrollLeft = 200; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#source')!, highlight = document.querySelector<HTMLElement>('#source-highlight')!;
    return input.scrollTop === highlight.scrollTop && input.scrollLeft === highlight.scrollLeft;
  })).toBe(true);
  await expect(source).toHaveValue(text);
  await source.fill('## Changed\n\n**new** <script>alert(1)</script>');
  await expect(page.locator('#source-highlight .hljs-section')).toHaveText('## Changed');
  await expect(page.locator('#source-highlight script')).toHaveCount(0);
  await expect(source).toHaveValue('## Changed\n\n**new** <script>alert(1)</script>');
});

test('source highlighting keeps the code background without inheriting its base text color or padding', async ({ page }) => {
  await open(page, '# Heading\n\nPlain text and **bold**.\n\n<details>Details</details>');
  await page.addStyleTag({ content: 'code { color: #ce9178; background-color: #333333; padding: 1px 3px; border-radius: 4px; }' });
  await page.getByRole('button', { name: 'Source view', exact: true }).click();
  const code = page.locator('#source-highlight > code');
  await expect(code).toHaveCSS('background-color', 'rgb(51, 51, 51)');
  await expect(code).toHaveCSS('padding', '0px');
  const foreground = await page.locator('#source-highlight').evaluate(element => getComputedStyle(element).color);
  await expect(code).toHaveCSS('color', foreground);
  await page.getByRole('button', { name: 'Split view', exact: true }).click();
  await expect(code).toHaveCSS('background-color', 'rgb(51, 51, 51)');
});

test('read-only preview disables editing while keeping all view switches and exports active', async ({ page }) => {
  const original = '# Heading\n\n**Bold** text.\n\n```js\nconst x = 1;\n```';
  const { state } = await open(page, original);
  await page.getByRole('button', { name: 'Read-only preview', exact: true }).click();
  const preview = page.locator('#preview-pane');
  await expect(preview).toBeVisible(); await expect(preview.locator('h1')).toHaveText('Heading');
  await expect(preview.locator('[contenteditable]')).toHaveCount(0);
  await expect(preview.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bold (Ctrl/Cmd+B)', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Normalize Document (undoable)', exact: true })).toBeDisabled();
  await expect(page.locator('summary[aria-label="Table actions"]')).toHaveAttribute('aria-disabled', 'true');
  for (const label of ['WYSIWYG view', 'Source view', 'Split view', 'Read-only preview', 'Export HTML', 'Export PDF']) await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
  await preview.focus(); await page.keyboard.type('This must not edit the file'); await page.keyboard.press('ControlOrMeta+z');
  expect((await state()).source).toBe(original);
  await preview.getByRole('button', { name: 'Copy Code', exact: true }).click();
  await expect.poll(async () => (await state()).copies[0]).toBe('const x = 1;');
  await page.getByRole('button', { name: 'Source view', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source', exact: true })).toHaveValue(original);
  await expect(page.getByRole('button', { name: 'Bold (Ctrl/Cmd+B)', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Read-only preview', exact: true }).click();
  await page.getByRole('button', { name: 'Split view', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Markdown document', exact: true })).toBeVisible();
});

test('math subscripts do not color the following source document as emphasis', async ({ page }) => {
  const text = '$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n## Details and notes\n\nOrdinary prose.';
  await open(page, text); await page.getByRole('button', { name: 'Source view', exact: true }).click();
  await expect(page.locator('#source-highlight .hljs-section')).toHaveText('## Details and notes');
  await expect(page.locator('#source-highlight .hljs-emphasis')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Markdown source', exact: true })).toHaveValue(text);
});
