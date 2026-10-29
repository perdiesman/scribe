import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/ui',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4178', trace: 'retain-on-failure' },
  webServer: { command: 'npm run build && node scripts/serve-test.mjs', url: 'http://127.0.0.1:4178', reuseExistingServer: false, timeout: 120_000 },
});
