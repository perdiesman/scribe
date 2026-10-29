import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function open(page: Page, source = '') {
  const id = randomUUID();
  await page.request.post(`/reset?id=${id}`, { data: { source } });
  await page.goto(`/?id=${id}`);
  await expect(page.getByRole('textbox', { name: 'Markdown document' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Ready');
  return { id, state: async () => (await page.request.get(`/state?id=${id}`)).json() };
}

test('Enter converts typed Markdown and shortcuts convert headings and emphasis', async ({ page }) => {
  await open(page);
  const editor = page.getByRole('textbox', { name: 'Markdown document' });
  await editor.pressSequentially('# Heading');
  await expect(editor.locator('h1')).toHaveText('Heading');
  await editor.press('Enter');
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
  await editor.pressSequentially(' visual');
  await expect.poll(async () => (await state()).recoveries.length).toBeGreaterThan(0);
  expect((await state()).recoveries.join('\n')).toContain('visual');
});
