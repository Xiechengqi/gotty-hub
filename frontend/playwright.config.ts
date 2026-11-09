import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://127.0.0.1:5181', locale: 'zh-CN', reducedMotion: 'reduce' },
  webServer: { command: 'npm run dev -- --port 5181 --strictPort', url: 'http://127.0.0.1:5181', reuseExistingServer: !process.env.CI },
});
