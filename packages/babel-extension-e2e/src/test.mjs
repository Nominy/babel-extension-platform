import { test as base, expect, chromium } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertIsolatedMutedBrowser, cancelNativeExtensionPermission, startNetworkFence } from './runner.mjs';

const storageKeys = { helper: 'settings', gold: 'babel_gold_drafting_settings', review: 'babel.review.settings.v1' };
const nativeDialogProfiles = new WeakMap();

async function runConfiguration() {
  if (!process.env.BABEL_E2E_RUN) throw new Error('Run browser specs with npm run e2e, not bare playwright test. --list needs no services.');
  return JSON.parse(await readFile(process.env.BABEL_E2E_RUN, 'utf8'));
}

async function jsonRequest(apiURL, endpoint, body) {
  const response = await fetch(`${apiURL}/__e2e__/${endpoint}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Scenario ${endpoint} failed (${response.status}): ${text}`);
  return JSON.parse(text);
}

async function attachArtifact(testInfo, filename, content, contentType) {
  const artifact = testInfo.outputPath(filename);
  await writeFile(artifact, content);
  await testInfo.attach(filename, { path: artifact, contentType });
}

async function withTeardownDeadline(label, operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Teardown ${label} exceeded its independent 5000ms diagnostic deadline`)), 5000);
      })
    ]);
  } finally { clearTimeout(timer); }
}

function selectedExtensions(run, names, reviewFlavor) {
  if (new Set(names).size !== names.length) throw new Error('Duplicate extension in test options.');
  return Object.fromEntries(names.map(name => {
    const artifact = name === 'review' ? run.extensions.review[reviewFlavor] : run.extensions[name];
    if (!artifact) throw new Error(`Unsupported extension/flavor: ${name}/${reviewFlavor}`);
    return [name, artifact];
  }));
}

async function extensionOptions(context, name, artifact) {
  if (!artifact?.options) throw new Error(`${name} is not installed in this test context.`);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${artifact.id}/${artifact.options}`);
  await expect.poll(() => page.evaluate(() => globalThis.chrome?.runtime?.id), { message: `Awaiting real ${name} extension registration` }).toBe(artifact.id);
  return page;
}

async function mergeSettings(context, name, artifact, settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError('Extension settings must be an object.');
  const options = await extensionOptions(context, name, artifact);
  try {
    return await options.evaluate(async ({ key, settings }) => {
      const current = await chrome.storage.local.get(key);
      const value = { ...(current[key] ?? {}), ...settings };
      await chrome.storage.local.set({ [key]: value });
      return (await chrome.storage.local.get(key))[key];
    }, { key: storageKeys[name], settings });
  } finally { await options.close(); }
}

async function observeExtensionErrors(context, events) {
  const session = await context.browser().newBrowserCDPSession();
  const attached = new Set();
  const pending = new Set();
  const attach = async info => {
    if (!info.url?.startsWith('chrome-extension://') || attached.has(info.targetId)) return;
    attached.add(info.targetId);
    try {
      const { sessionId } = await session.send('Target.attachToTarget', { targetId: info.targetId, flatten: false });
      await session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.enable' }) });
      await session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 2, method: 'Log.enable' }) });
    } catch (error) {
      // Targets can disappear while registering. Keep the evidence instead of hiding it.
      events.push({ type: 'target-observer', target: info.url, message: error.message });
    }
  };
  session.on('Target.targetCreated', ({ targetInfo }) => { const task = attach(targetInfo); pending.add(task); task.finally(() => pending.delete(task)); });
  session.on('Target.targetInfoChanged', ({ targetInfo }) => { const task = attach(targetInfo); pending.add(task); task.finally(() => pending.delete(task)); });
  session.on('Target.receivedMessageFromTarget', ({ message, targetId }) => {
    const event = JSON.parse(message);
    if (event.method === 'Runtime.exceptionThrown') events.push({ type: 'worker-error', targetId, details: event.params.exceptionDetails });
    if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') events.push({ type: 'worker-log', targetId, details: event.params.entry });
  });
  await session.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = await session.send('Target.getTargets');
  await Promise.all(targetInfos.map(attach));
  return async () => { await Promise.allSettled(pending); await session.detach(); };
}

async function installNetworkRoutes(context, run, events) {
  const local = new Set([new URL(run.baseURL).origin, new URL(run.apiURL).origin]);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (['/__e2e__/control', '/__e2e__/reset'].includes(url.pathname)) {
      events.push({ type: 'network-denied', method: request.method(), url: url.origin + url.pathname, reason: 'node-only-scenario-control' });
      await route.abort('blockedbyclient'); return;
    }
    if (local.has(url.origin) || ['chrome-extension:', 'data:', 'blob:', 'about:'].includes(url.protocol)) {
      await route.continue(); return;
    }
    if (url.origin === 'https://reviewgen.ovh') {
      const headers = await request.allHeaders();
      for (const key of ['host', 'cookie', 'authorization', 'proxy-authorization', 'content-length']) delete headers[key];
      headers['x-babel-e2e-original-origin'] = url.origin;
      try {
        const response = await fetch(`${run.apiURL}${url.pathname}${url.search}`, {
          method: request.method(), headers, body: request.postDataBuffer() ?? undefined, redirect: 'manual'
        });
        const responseHeaders = Object.fromEntries(response.headers);
        delete responseHeaders['content-encoding']; delete responseHeaders['content-length'];
        await route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) });
      } catch (error) {
        events.push({ type: 'scenario-transport-error', url: url.origin + url.pathname, message: error.message });
        await route.abort('failed');
      }
      return;
    }
    events.push({ type: 'network-denied', method: request.method(), url: url.origin + url.pathname, scope: request.serviceWorker() ? 'service-worker' : 'page' });
    await route.abort('blockedbyclient');
  });
}

export const test = base.extend({
  scenario: ['baseline', { option: true }],
  extensions: [['helper', 'gold', 'review'], { option: true }],
  reviewFlavor: ['dev', { option: true }],
  nativePermissionDialogs: [false, { option: true }],
  visibleScrollbars: [false, { option: true }],
  _run: async ({}, use) => use(await runConfiguration()),
  _artifacts: async ({ _run, extensions, reviewFlavor }, use) => use(selectedExtensions(_run, extensions, reviewFlavor)),
  _diagnostics: async ({}, use) => use([]),

  context: async ({ _run, _artifacts, _diagnostics, nativePermissionDialogs, visibleScrollbars }, use, testInfo) => {
    let profile, fence, context, stopObserving, setupFailure;
    let tracingStarted = false;
    let startupPhase = 'profile-allocation';
    try {
      if (nativePermissionDialogs && _run.headed) throw new Error('Native permission dialog automation is restricted to isolated headless Chromium.');
      profile = await mkdtemp(path.join(_run.work, 'profile-'));
      startupPhase = 'network-fence';
      fence = await startNetworkFence({ allowedOrigins: [_run.baseURL, _run.apiURL], events: _diagnostics });
      startupPhase = 'browser-launch';
      const extensionPaths = Object.values(_artifacts).map(item => item.directory);
      const args = [
        '--proxy-bypass-list=<-loopback>',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-quic',
        '--mute-audio',
        '--enable-automation',
        ...(extensionPaths.length ? [`--disable-extensions-except=${extensionPaths.join(',')}`, `--load-extension=${extensionPaths.join(',')}`] : []),
        ...(nativePermissionDialogs ? ['--enable-ui-devtools=0', '--enable-features=ui-debug-tools-enable-synthetic-events'] : [])
      ];
      const launchedContext = await chromium.launchPersistentContext(profile, {
        executablePath: _run.browserExecutable, channel: 'chromium', headless: !_run.headed,
        ignoreDefaultArgs: ['--disable-extensions', ...(visibleScrollbars ? ['--hide-scrollbars'] : [])],
        args, proxy: { server: fence.url }, serviceWorkers: 'allow',
        viewport: { width: 1600, height: 1000 }, locale: 'en-US', timezoneId: 'UTC',
        acceptDownloads: true, downloadsPath: path.join(profile, 'downloads')
      });
      startupPhase = 'browser-safety-attestation';
      await assertIsolatedMutedBrowser(launchedContext, profile);
      context = launchedContext;
      if (nativePermissionDialogs) nativeDialogProfiles.set(context, profile);
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracingStarted = true;
      startupPhase = 'browser-observers';
      context.on('page', page => {
        page.on('pageerror', error => _diagnostics.push({ type: 'page-error', url: page.url(), message: error.stack ?? error.message }));
        page.on('console', message => { if (message.type() === 'error') _diagnostics.push({ type: 'console-error', url: page.url(), message: message.text() }); });
        page.on('crash', () => _diagnostics.push({ type: 'page-crash', url: page.url() }));
      });
      context.on('requestfailed', request => _diagnostics.push({ type: 'request-failed', url: new URL(request.url()).origin + new URL(request.url()).pathname, error: request.failure()?.errorText }));
      await installNetworkRoutes(context, _run, _diagnostics);
      if (_run.nano === 'placeholder') {
        const { browserModelInitScript } = await import('./providers.mjs');
        await context.addInitScript(browserModelInitScript);
      }
      stopObserving = await observeExtensionErrors(context, _diagnostics);
      startupPhase = 'extension-registration';
      for (const [name, artifact] of Object.entries(_artifacts)) {
        const settings = name === 'gold' ? {
          backendBaseUrl: _run.apiURL, l0CustomBaseUrl: _run.apiURL,
          openRouterApiKey: 'e2e-placeholder-not-a-secret', model: _run.openrouterModel ?? 'e2e-placeholder-v1'
        } : name === 'review' ? { backendBaseUrl: _run.apiURL, backendBaseUrlFallbacks: [] } : {};
        if (artifact.manifest.permissions?.includes('storage')) await mergeSettings(context, name, artifact, settings);
        else { const registration = await extensionOptions(context, name, artifact); await registration.close(); }
        if (artifact.manifest.background?.service_worker) {
          await expect.poll(() => context.serviceWorkers().some(worker => worker.url().startsWith(`chrome-extension://${artifact.id}/`)), {
            message: `Awaiting actual ${name} service worker`, timeout: 20_000
          }).toBe(true);
        }
      }
      for (const page of context.pages()) await page.close();
      startupPhase = 'test';
      await use(context);
    } catch (error) {
      setupFailure = error;
      _diagnostics.push({ type: 'fixture-error', phase: startupPhase, name: error.name, code: error.code, syscall: error.syscall, message: error.message, stack: error.stack, cause: error.cause?.stack ?? error.cause?.message });
      throw error;
    } finally {
      const uncaught = _diagnostics.filter(item => ['page-error', 'worker-error', 'page-crash'].includes(item.type));
      const failed = Boolean(setupFailure) || testInfo.status !== testInfo.expectedStatus || uncaught.length > 0;
      const teardownErrors = [];
      const capture = async (label, operation) => {
        try { return { ok: true, value: await withTeardownDeadline(label, operation) }; } catch (error) {
          teardownErrors.push({ type: 'teardown-error', operation: label, message: error.message, stack: error.stack });
          return { ok: false };
        }
      };
      try {
        if (failed) {
          await attachArtifact(testInfo, 'browser-diagnostics.json', JSON.stringify({ phase: startupPhase, errors: testInfo.errors, events: _diagnostics }, null, 2), 'application/json');
          const state = await capture('scenario-state', () => jsonRequest(_run.apiURL, 'state'));
          if (state.ok) await attachArtifact(testInfo, 'scenario-state.json', JSON.stringify(state.value, null, 2), 'application/json');
        }
        if (context) {
          if (failed) {
            for (const [index, page] of context.pages().entries()) {
              // Renderer starvation can prevent Playwright's own screenshot timeout from settling.
              const screenshot = await capture(`page-${index}-screenshot`, () => page.screenshot({ fullPage: true, timeout: 5000 }));
              if (screenshot.ok) await attachArtifact(testInfo, `page-${index}.png`, screenshot.value, 'image/png');
            }
            if (tracingStarted) {
              const trace = testInfo.outputPath('trace.zip');
              const saved = await capture('trace-save', () => context.tracing.stop({ path: trace }));
              if (saved.ok) await testInfo.attach('trace', { path: trace, contentType: 'application/zip' });
            }
          } else if (tracingStarted) await capture('trace-stop', () => context.tracing.stop());
        }
      } finally {
        try {
          try {
            if (stopObserving) await capture('observer-detach', stopObserving);
          } finally {
            if (context) {
              const closed = await capture('context-close', () => context.close());
              // This Browser belongs to the attested temporary persistent context, never a relay.
              if (!closed.ok) await context.browser().close();
            }
          }
        } finally {
          try { await fence?.close(); } finally {
            try {
              if (teardownErrors.length) await attachArtifact(testInfo, 'teardown-diagnostics.json', JSON.stringify({ errors: teardownErrors }, null, 2), 'application/json');
            } finally {
              if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            }
          }
        }
      }
      if (teardownErrors.length && !failed) throw new Error(`Browser fixture teardown failed: ${JSON.stringify(teardownErrors)}`);
      if (uncaught.length && testInfo.status === testInfo.expectedStatus) throw new Error(`Uncaught browser/extension error: ${JSON.stringify(uncaught)}`);
    }
  },

  babel: [async ({ page, context, _run, _artifacts, _diagnostics, scenario }, use) => {
    const babel = {
      baseURL: _run.baseURL, apiURL: _run.apiURL,
      extensionIds: Object.fromEntries(Object.entries(_artifacts).map(([name, item]) => [name, item.id])),
      ai: _run.ai, browserModels: _run.browserModels, nano: _run.nano,
      hasSpeechFixtures: Boolean(_run.speechFixtures),
      state: () => jsonRequest(_run.apiURL, 'state'),
      control: payload => jsonRequest(_run.apiURL, 'control', payload),
      async cancelExtensionPermission(name) {
        const profile = nativeDialogProfiles.get(context);
        if (!profile) throw new Error('Enable nativePermissionDialogs for this isolated headless test before canceling an extension permission.');
        const artifact = _artifacts[name];
        if (!artifact) throw new Error(`${name} is not installed in this test context.`);
        await cancelNativeExtensionPermission({ profile, displayName: artifact.manifest.name, events: _diagnostics });
      },
      async reset(name = 'baseline', overrides = {}) {
        const state = await jsonRequest(_run.apiURL, 'reset', { scenario: name, overrides });
        const route = typeof state.route === 'string' ? state.route : `${state.page.path}${state.page.search ?? ''}`;
        await page.goto(new URL(route, _run.baseURL).href);
        await page.locator('#root').waitFor({ state: 'attached' });
        if (_artifacts.gold) await expect(page.locator('html')).toHaveAttribute('data-babel-gold-drafting-extension-id', _artifacts.gold.id, { timeout: 20_000 });
        return state;
      },
      setExtensionSettings: (name, settings) => mergeSettings(context, name, _artifacts[name], settings),
      options: name => extensionOptions(context, name, _artifacts[name]),
      async installUserscript() {
        if (!_artifacts.helper) throw new Error('The actual Helper build is required to load its userscript SDK.');
        await page.addScriptTag({ path: path.join(_artifacts.helper.directory, 'dist/userscript/babel-mods.js') });
      }
    };
    await babel.reset(scenario);
    await use(babel);
  }, { auto: true }]
});

export { expect };
