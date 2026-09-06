import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageDir, repositoryDir } from './src/build.mjs';
import { getCapabilityTags } from './src/runner.mjs';

const run = process.env.BABEL_E2E_RUN ? JSON.parse(readFileSync(process.env.BABEL_E2E_RUN, 'utf8')) : JSON.parse(process.env.BABEL_E2E_MODE_OPTIONS ?? '{}');
const capabilityTags = getCapabilityTags(run);

export default defineConfig({
  testDir: repositoryDir,
  testMatch: [
    'shared/babel-extension-platform/packages/babel-extension-e2e/tests/e2e/**/*.spec.mjs',
    'babel-helper-extension-repo/tests/e2e/**/*.spec.mjs',
    'drafting/gold-drafting-extension/tests/e2e/**/*.spec.mjs',
    'reviewer/review-interceptor-extension/tests/e2e/**/*.spec.mjs'
  ],
  grep: capabilityTags.length ? new RegExp(`(?:^|\\s)(?:${capabilityTags.join('|')})(?=\\s|$)`) : undefined,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: process.env.BABEL_E2E_OUTPUT ?? path.join(packageDir, 'node_modules/.cache/babel-e2e/results'),
  preserveOutput: 'failures-only',
  reporter: [['list']],
  use: {
    baseURL: run.baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off'
  },
  projects: [{
    name: 'chromium-extensions',
    metadata: { ai: run.ai ?? 'placeholder', browserModels: run.browserModels ?? 'placeholder', nano: run.nano ?? 'placeholder', hasSpeechFixtures: Boolean(run.speechFixtures) }
  }]
});
