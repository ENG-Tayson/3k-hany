import { defineConfig } from '@playwright/test';

// اختبارات المتصفح على الواجهة الحقيقية + مشروع Supabase السحابي بحساب اختبار E2E منفصل.
export default defineConfig({
  testDir: 'e2e',
  testMatch: process.env.GL_E2E_RESTART ? 'restart.spec.ts' : 'flows.spec.ts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],
  outputDir: 'e2e/test-results',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    locale: 'ar-EG',
    timezoneId: 'Africa/Cairo',
    trace: 'on',
    screenshot: 'on',
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
