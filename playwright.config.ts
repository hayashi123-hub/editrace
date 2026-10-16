import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'desktop.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results',
});
