import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'scribe-vscode-'));
try {
  const tests = join(temporary, 'extension-tests.cjs');
  await build({ entryPoints: ['test/extension.test.ts'], outfile: tests, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'] });
  await runTests({ extensionDevelopmentPath: resolve('.'), extensionTestsPath: tests,
    launchArgs: [temporary, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
  });
} finally { await rm(temporary, { recursive: true, force: true }); }
