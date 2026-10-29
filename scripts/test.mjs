import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporary = await mkdtemp(join(tmpdir(), 'scribe-test-'));
try {
  const file = join(temporary, 'core.test.cjs');
  const probe = join(temporary, 'pdf-probe.js');
  await build({ entryPoints: ['src/pdfRenderer.ts'], outfile: probe, bundle: true, platform: 'browser', format: 'iife', globalName: 'ScribePdfProbe', minify: true, target: 'es2022' });
  await build({ entryPoints: ['test/core.test.ts'], outfile: file, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning', alias: { vscode: './test/vscode-stub.ts' } });
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', env: { ...process.env, SCRIBE_PDF_PROBE: probe } });
  process.exitCode = result.status ?? 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
