import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';

const baseURL = 'http://127.0.0.1:4178';
const source = await readFile('test/fixtures/sample.md', 'utf8');
const browser = await chromium.launch();
const server = spawn(process.execPath, ['scripts/serve-test.mjs'], { stdio: 'inherit' });
try {
  const deadline = Date.now() + 30_000;
  while (true) {
    if (server.exitCode !== null) throw new Error('Screenshot server exited before becoming ready');
    try { if ((await fetch(baseURL)).ok) break; } catch { /* Wait for the existing UI harness to start. */ }
    if (Date.now() > deadline) throw new Error('Screenshot server did not start');
    await setTimeout(100);
  }
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const reset = await page.request.post(`${baseURL}/reset?id=screenshots`, { data: { source } });
  assert.ok(reset.ok());
  await page.goto(`${baseURL}/?id=screenshots`);
  await page.getByRole('textbox', { name: 'Markdown document', exact: true }).waitFor();
  await page.evaluate(() => {
    document.body.classList.add('vscode-dark');
    const theme = {
      '--vscode-editor-background': '#1e1e1e', '--vscode-editor-foreground': '#d4d4d4',
      '--vscode-sideBar-background': '#252526', '--vscode-panel-border': '#3c3c3c',
      '--vscode-descriptionForeground': '#aaaaaa', '--vscode-focusBorder': '#007fd4',
      '--vscode-textCodeBlock-background': '#2b2b2b', '--vscode-textLink-foreground': '#4daafc',
      '--vscode-dropdown-background': '#3c3c3c', '--vscode-dropdown-foreground': '#f0f0f0',
      '--vscode-font-family': 'system-ui, sans-serif', '--vscode-editor-font-family': 'monospace',
    };
    for (const [name, value] of Object.entries(theme)) document.body.style.setProperty(name, value);
  });
  await page.locator('.diagram-preview svg').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await mkdir('docs/screenshots', { recursive: true });
  const views = [['wysiwyg', 'WYSIWYG view'], ['source', 'Source view'], ['split', 'Split view'], ['preview', 'Read-only preview']];
  for (const [mode, label] of views) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction(value => document.querySelector('#workspace')?.getAttribute('data-mode') === value, mode);
    await page.getByRole('navigation', { name: 'Table of contents' }).waitFor();
    if (mode === 'preview') await page.locator('#preview-pane .mermaid svg').waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const png = await page.screenshot({ path: `docs/screenshots/${mode}.png` });
    assert.ok(png.length > 0);
    assert.equal((await (await page.request.get(`${baseURL}/state?id=screenshots`)).json()).source, source);
  }
  assert.deepEqual(errors, []);
  const readme = await readFile('README.md', 'utf8');
  const screenshots = '## Editor views\n\nCaptured from [`test/fixtures/sample.md`](test/fixtures/sample.md), with the table of contents visible.\n\n'
    + views.map(([mode, label]) => `**${label}**\n\n![SCRIBE ${label} with table of contents](docs/screenshots/${mode}.png)`).join('\n\n');
  assert.ok(readme.includes('<!-- screenshots:start -->'), 'README screenshot insertion marker is missing');
  await writeFile('README.md', readme.replace(/<!-- screenshots:start -->[\s\S]*?<!-- screenshots:end -->/, `<!-- screenshots:start -->\n${screenshots}\n<!-- screenshots:end -->`));
  console.log('Captured all four sample editor views and updated README.md. Commit README.md and docs/screenshots/.');
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
