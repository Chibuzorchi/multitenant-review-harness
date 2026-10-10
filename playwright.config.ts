import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { environment } from './config/environment';
import { installHarnessEgressGuard } from './review-harness/lib/egress-guard';
import { runPaths } from './review-harness/lib/run';

// Loaded by the runner and by every worker: none of them may reach a non-local host.
installHarnessEgressGuard('playwright');

const stage = process.env.REVIEW_STAGE ?? 'adhoc';

/** The browser may resolve local names only; every other lookup fails inside Chromium itself. */
const launchOptions = {
  args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost, EXCLUDE 127.0.0.1', '--disable-background-networking', '--disable-component-update', '--no-first-run'],
};

const browserUse = {
  screenshot: 'only-on-failure',
  video: 'retain-on-failure',
  launchOptions,
} as const;

export default defineConfig({
  testDir: './review-harness',
  outputDir: path.join(runPaths.playwrightOutput(), stage),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 5_000 },
  reporter: [['line'], ['json', { outputFile: path.join(runPaths.results(), `${process.env.REVIEW_RESULT_NAME ?? stage}.json`) }]],
  use: {
    baseURL: environment.baseUrl,
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    { name: 'api', testMatch: /.*\.api\.spec\.ts$/ },
    { name: 'desktop-chromium', testMatch: /.*\.ui\.spec\.ts$/, use: { ...devices['Desktop Chrome'], ...browserUse } },
    { name: 'mobile-chromium', testMatch: /(01-baseline|03-sessions)\/.*\.ui\.spec\.ts$/, use: { ...devices['Pixel 7'], ...browserUse } },
    { name: 'final', testMatch: /.*\.final\.spec\.ts$/ },
  ],
});
