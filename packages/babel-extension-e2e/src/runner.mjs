import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { buildExtensions, linkDependencies, packageDir, repositoryDir, requirePath } from './build.mjs';

const help = `Babel native editor + actual extension browser E2E (isolated profiles only)

Usage: npm run e2e -- [runner options] [Playwright test filters/options]
  --list                         Discover all specs; no builds, browser or services
  --help                         Show this help without services
  --headed                       Show isolated bundled Chromium (default headless)
  --ai=placeholder|openrouter|local  Heavy server inference (default placeholder)
  --openrouter-model=ID           Required with --ai=openrouter; OPENROUTER_API_KEY required
  --local-engine-url=URL          Required with --ai=local; existing /v1 engine only
                                 local selects ASR-compatible journeys; no LLM fallback
  --browser-models=placeholder|real  Gold offscreen ONNX inference (default placeholder)
                                 real requires BABEL_E2E_BROWSER_MODEL_DIR manifest/weights
                                 and sample-russian-15s.wav (mono PCM16, at most 15 seconds)
  --nano=placeholder|real         Chrome LanguageModel boundary (default placeholder)
                                 real requires --speech-fixtures and an already available
                                 audio/text LanguageModel for the production review contract
  --browser-executable=PATH       Explicit provisioned Chromium for --nano=real only
  --speech-fixtures=DIR           Explicit local speech WAVs/annotations for real-ASR journeys
  --grep=REGEXP                   Select journeys; standard Playwright filters also accepted

Install dependencies: npm ci --ignore-scripts
Install pinned browser explicitly: npm run e2e:install:browser
Install snapshot runtime explicitly: npm run e2e:install:recreation
Also run npm ci --ignore-scripts in each of the three extension repositories.
No implicit browser/dependency/model provisioning, version bump or publish occurs during e2e.
Browser egress is loopback-only, including service workers and offscreen pages.
Real provider HTTP dispatch happens only in the scenario gateway under explicit flags.
Failure-only traces, screenshots and diagnostics are printed under the package node_modules cache.
`;

export function parseOptions(args) {
  const options = { ai: 'placeholder', browserModels: 'placeholder', nano: 'placeholder', headed: false };
  const playwrightArgs = [];
  const values = new Map([
    ['ai', 'ai'], ['openrouter-model', 'openrouterModel'], ['local-engine-url', 'localEngineUrl'],
    ['browser-models', 'browserModels'], ['nano', 'nano'], ['browser-executable', 'browserExecutable'],
    ['speech-fixtures', 'speechFixtures']
  ]);
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--') continue;
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--list') { options.list = true; playwrightArgs.push(argument); }
    else if (argument === '--headed') options.headed = true;
    else {
      const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
      if (match && values.has(match[1])) {
        const value = match[2] ?? args[++i];
        if (!value || value.startsWith('--')) throw new Error(`--${match[1]} requires a value.`);
        options[values.get(match[1])] = value;
      } else {
        if (/^--(?:workers|config|ui|debug|pass-with-no-tests|shard|only-changed|test-list|test-list-invert)(?:=|$)/.test(argument) || argument === '-c' || argument === '-j') {
          throw new Error(`${argument} would bypass the isolated single-worker runner; use supported test filters instead.`);
        }
        playwrightArgs.push(argument);
      }
    }
  }
  if (!['placeholder', 'openrouter', 'local'].includes(options.ai)) throw new Error('Invalid --ai; expected placeholder, openrouter or local.');
  for (const key of ['browserModels', 'nano']) if (!['placeholder', 'real'].includes(options[key])) throw new Error(`Invalid ${key}; expected placeholder or real.`);
  return { options, playwrightArgs };
}

export function getCapabilityTags(options) {
  if (options.ai !== 'local') return [];
  return ['@local-engine', ...(options.browserModels === 'real' ? ['@browser-models'] : []), ...(options.nano === 'real' ? ['@nano'] : [])];
}

export async function preflight(options) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 14)) throw new Error('Babel E2E requires Node 22.14 or newer.');
  if (options.ai === 'openrouter' && (!options.openrouterModel || !process.env.OPENROUTER_API_KEY?.trim())) {
    throw new Error('--ai=openrouter requires --openrouter-model and OPENROUTER_API_KEY. The default never reads this key.');
  }
  if (options.ai === 'local') {
    if (!options.localEngineUrl) throw new Error('--ai=local requires --local-engine-url; start and provision the real local engine explicitly.');
    const endpoint = new URL(options.localEngineUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Local engine URL must be HTTP(S), without credentials.');
  }
  if (options.ai !== 'openrouter' && options.openrouterModel) throw new Error('--openrouter-model requires --ai=openrouter.');
  if (options.ai !== 'local' && options.localEngineUrl) throw new Error('--local-engine-url requires --ai=local.');
  if (options.browserExecutable && options.nano !== 'real') throw new Error('--browser-executable is reserved for explicit --nano=real provisioned-browser verification.');
  if (options.speechFixtures) {
    options.speechFixtures = path.resolve(options.speechFixtures);
    await requirePath(path.join(options.speechFixtures, 'manifest.json'), 'Supply the explicit babel-e2e-speech-v1 manifest and two local mono PCM16 WAVs.');
  }
  if (options.nano === 'real' && !options.speechFixtures) {
    throw new Error('--nano=real requires --speech-fixtures for the reachable audio/text transcript-review journey.');
  }
  if (options.browserModels === 'real') {
    options.browserModelDir = process.env.BABEL_E2E_BROWSER_MODEL_DIR;
    if (!options.browserModelDir) throw new Error('--browser-models=real requires BABEL_E2E_BROWSER_MODEL_DIR containing the real manifest and weights. No models are downloaded implicitly.');
    options.browserModelDir = path.resolve(options.browserModelDir);
    await requirePath(path.join(options.browserModelDir, 'manifest.json'), 'Provision the actual Gold browser model bundle before running the real lane.');
    const sample = path.join(options.browserModelDir, 'sample-russian-15s.wav');
    await requirePath(sample, '--browser-models=real requires its actual supplied Russian sample WAV as well as manifest/weights.');
    const sampleInfo = await stat(sample);
    if (!sampleInfo.isFile() || sampleInfo.size > 64 * 1024 * 1024) throw new Error('Real browser-model sample must be a regular WAV file no larger than 64 MiB.');
    const relative = path.relative(await realpath(options.browserModelDir), await realpath(sample));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Real browser-model sample resolves outside its configured directory.');
    const { wavInfo } = await import('../fixture-data/speech-fixtures.mjs');
    const { duration } = wavInfo(await readFile(sample));
    if (duration > 15) throw new Error('Real browser-model sample-russian-15s.wav must be no longer than 15 seconds.');
  }
  const { chromium } = await import('@playwright/test');
  const executable = options.browserExecutable ? path.resolve(options.browserExecutable) : chromium.executablePath();
  await requirePath(executable, 'Install the pinned browser explicitly: npm run e2e:install:browser (from shared/babel-extension-platform).');
  options.browserExecutable = executable;
  await requirePath(path.join(packageDir, 'fixtures/recreation/app/node_modules/vite/package.json'), 'Run npm run e2e:install:recreation after generating the pinned snapshot.');
  return options;
}

export async function validateBrowserModelDirectory(directory) {
  const source = path.join(repositoryDir, 'drafting/gold-drafting-extension/src/core/local-model-bundle.ts');
  const requireGold = createRequire(path.join(repositoryDir, 'drafting/gold-drafting-extension/package.json'));
  const { transform } = await import(pathToFileURL(requireGold.resolve('esbuild')).href);
  const result = await transform(`${await readFile(source, 'utf8')}\nexport { validateManifest };`, { loader: 'ts', format: 'esm', target: 'node22' });
  const { validateManifest } = await import(`data:text/javascript;base64,${Buffer.from(result.code).toString('base64')}`);
  const manifest = validateManifest(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')));
  const root = await realpath(directory);
  for (const file of manifest.files) {
    const filename = await realpath(path.join(root, file.path));
    const relative = path.relative(root, filename);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Browser model file escapes fixture directory: ${file.path}`);
    if ((await stat(filename)).size !== file.bytes) throw new Error(`Browser model byte size mismatch: ${file.path}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256) throw new Error(`Browser model SHA-256 mismatch: ${file.path}`);
  }
  return { files: manifest.files.length, totalBytes: manifest.totalBytes };
}

export async function assertIsolatedMutedBrowser(context, profile) {
  try {
    const session = await context.browser().newBrowserCDPSession();
    try {
      const { arguments: commandLine } = await session.send('Browser.getBrowserCommandLine');
      if (!commandLine.includes('--mute-audio') || commandLine.some(argument => argument.startsWith('--mute-audio='))) {
        throw new Error('Owned Chromium did not start with unconditional --mute-audio.');
      }
      const profileArguments = commandLine.filter(argument => argument === '--user-data-dir' || argument.startsWith('--user-data-dir='));
      if (profileArguments.length !== 1 || profileArguments[0] !== `--user-data-dir=${path.resolve(profile)}`) {
        throw new Error('Owned Chromium user-data-dir does not exactly match its newly allocated temporary profile.');
      }
    } finally {
      await session.detach();
    }
  } catch (error) {
    try { await context.close(); } catch (closeError) {
      throw new AggregateError([error, closeError], 'Browser startup safety check and owned-browser closure failed.');
    }
    throw new Error('Browser startup safety check failed before test navigation; owned Chromium was closed.', { cause: error });
  }
}

export async function cancelNativeExtensionPermission({ profile, displayName, events, timeout = 15_000 }) {
  const deadline = Date.now() + timeout;
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error(`Timed out canceling the native permission dialog for ${displayName}.`);
    return milliseconds;
  };
  let port;
  while (port === undefined) {
    remaining();
    try {
      const value = (await readFile(path.join(profile, 'UIDevToolsActivePort'), 'utf8')).trim();
      if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('Invalid owned UI DevTools port file.');
      port = Number(value);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(Math.min(50, remaining()));
    }
  }
  const connectionBudget = remaining();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/0`);
  const pending = new Map();
  let nextId = 1;
  let rejectOpen;
  let closed = false;
  let observedDialogs = [];
  const fail = error => {
    rejectOpen?.(error);
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
  };
  const timer = setTimeout(() => {
    fail(new Error(`Native UI DevTools deadline exceeded for ${displayName}.`));
    socket.close();
  }, connectionBudget);
  const opened = new Promise((resolve, reject) => {
    rejectOpen = reject;
    socket.addEventListener('open', resolve, { once: true });
  });
  socket.addEventListener('error', () => fail(new Error('Owned UI DevTools connection failed.')));
  socket.addEventListener('close', () => { closed = true; fail(new Error('Owned UI DevTools connection closed.')); });
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id);
      if (message.error) operation.reject(new Error(`Native ${operation.method}: ${message.error.message}`));
      else operation.resolve(message.result);
    } catch (error) { fail(error); socket.close(); }
  });
  const send = (method, params = {}) => {
    remaining();
    if (closed || socket.readyState !== WebSocket.OPEN) throw new Error('Owned UI DevTools is not open.');
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  const snapshot = async () => {
    const { root } = await send('DOM.getDocument');
    const nodes = [];
    const visit = (node, parent) => {
      const attributes = Object.fromEntries(Array.from({ length: (node.attributes?.length ?? 0) / 2 }, (_, index) => [node.attributes[index * 2], node.attributes[index * 2 + 1]]));
      const record = { node, parent, className: attributes.class };
      nodes.push(record);
      for (const child of node.children ?? []) visit(child, record);
    };
    visit(root, null);
    return nodes;
  };
  const within = (record, ancestor) => {
    for (let current = record; current; current = current.parent) if (current === ancestor) return true;
    return false;
  };
  const findDialog = async () => {
    const nodes = await snapshot();
    const matches = [];
    observedDialogs = [];
    for (const dialog of nodes.filter(record => record.className === 'ExtensionInstallDialogView')) {
      let widget = dialog;
      while (widget && widget.node.nodeName !== 'Widget') widget = widget.parent;
      if (!widget) throw new Error('Native extension dialog has no owning Widget.');
      let client = dialog.parent;
      while (client && client.className !== 'DialogClientView') client = client.parent;
      if (!client) throw new Error('Native extension dialog has no DialogClientView.');
      const wrappers = nodes.filter(record => record.className === 'TitleLabelWrapper' && within(record, widget));
      const labels = nodes.filter(record => record.className === 'Label' && wrappers.some(wrapper => within(record, wrapper)));
      const titles = [];
      for (const label of labels) {
        const styles = await send('CSS.getMatchedStylesForNode', { nodeId: label.node.nodeId });
        for (const rule of styles.matchedCSSRules ?? []) {
          for (const property of rule.rule.style.cssProperties) if (property.name === 'Text') titles.push(property.value);
        }
      }
      observedDialogs.push({ dialogId: dialog.node.nodeId, widgetId: widget.node.nodeId, titleWrappers: wrappers.length, titles });
      const matchingTitles = titles.filter(value => value.includes(displayName));
      if (matchingTitles.length > 1) throw new Error(`Ambiguous native permission title for ${displayName}; refusing input.`);
      if (matchingTitles.length === 1) matches.push({ dialog, client, nodes, title: matchingTitles[0] });
    }
    if (matches.length > 1) throw new Error(`Ambiguous native permission dialogs for ${displayName}; refusing input.`);
    return matches[0];
  };
  try {
    await opened;
    await send('DOM.enable');
    await send('CSS.enable');
    let match;
    while (!(match = await findDialog())) await delay(Math.min(100, remaining()));
    events.push({ type: 'native-permission-dialog', extension: displayName, title: match.title });
    // Chromium's native input protector uses GetDoubleClickTime on Windows
    // (documented maximum 5000 ms). Preserve it and make only one click.
    if (remaining() < 5_100) throw new Error('Insufficient native dialog deadline for input protection.');
    await delay(5_100);
    match = await findDialog();
    if (!match) throw new Error('Native extension permission dialog disappeared before cancellation.');
    const search = await send('DOM.performSearch', { query: 'id:DialogClientView::kCancelButtonElementId' });
    let candidates = [];
    try {
      if (search.resultCount) {
        const result = await send('DOM.getSearchResults', { searchId: search.searchId, fromIndex: 0, toIndex: search.resultCount });
        candidates = match.nodes.filter(record => result.nodeIds.includes(record.node.nodeId) && within(record, match.client));
      }
    } finally { await send('DOM.discardSearchResults', { searchId: search.searchId }); }
    if (candidates.length !== 1) throw new Error(`Expected one native Cancel control for ${displayName}, found ${candidates.length}.`);
    const nodeId = candidates[0].node.nodeId;
    const { boundsInScreen: bounds } = await send('DOM.getNodeBoundsInScreen', { nodeId });
    if (!(bounds.width > 0 && bounds.height > 0)) throw new Error('Native Cancel control has no actionable bounds.');
    const event = { x: Math.floor(bounds.width / 2), y: Math.floor(bounds.height / 2), button: 'left', wheelDirection: 'none' };
    await send('DOM.dispatchMouseEvent', { nodeId, event: { ...event, type: 'mousePressed' } });
    await send('DOM.dispatchMouseEvent', { nodeId, event: { ...event, type: 'mouseReleased' } });
    while (await findDialog()) await delay(Math.min(100, remaining()));
    events.push({ type: 'native-permission-canceled', extension: displayName, title: match.title });
  } catch (error) {
    events.push({ type: 'native-permission-error', extension: displayName, message: error.message, observedDialogs });
    throw error;
  } finally {
    clearTimeout(timer);
    socket.close();
    fail(new Error('Owned UI DevTools session disposed.'));
  }
}

async function productionNanoSessionOptions() {
  const helperRoot = path.join(repositoryDir, 'babel-helper-extension-repo');
  const requireHelper = createRequire(path.join(helperRoot, 'package.json'));
  const typescript = await import(pathToFileURL(requireHelper.resolve('typescript')).href);
  const ts = typescript.default ?? typescript;
  const filename = path.join(helperRoot, 'src/content/magnifier-bridge.ts');
  const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = [];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'AUTO_SEGMENT_PROMPT_SESSION_OPTIONS') declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (declarations.length !== 1 || !declarations[0].initializer || !ts.isObjectLiteralExpression(declarations[0].initializer)) {
    throw new Error('Cannot resolve the production Helper Nano audio/text review session contract.');
  }
  const { outputText } = ts.transpileModule(`export default ${declarations[0].initializer.getText(source)};`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)).default;
}

async function assertNanoAvailable(options, directory) {
  const sessionOptions = await productionNanoSessionOptions();
  const origin = createHttpServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Babel E2E Nano preflight</title>'));
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${origin.address().port}`;
  const fence = await startNetworkFence({ allowedOrigins: [url] });
  const profile = await mkdtemp(path.join(directory, 'nano-preflight-'));
  let browser;
  try {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launchPersistentContext(profile, {
      executablePath: options.browserExecutable, channel: 'chromium', headless: !options.headed,
      proxy: { server: fence.url }, args: ['--enable-automation', '--mute-audio', '--proxy-bypass-list=<-loopback>', '--disable-quic']
    });
    await assertIsolatedMutedBrowser(browser, profile);
    const page = await browser.newPage();
    await page.goto(url);
    const available = await page.evaluate(async sessionOptions => typeof globalThis.LanguageModel?.availability === 'function' ? await globalThis.LanguageModel.availability(sessionOptions) : 'unavailable', sessionOptions);
    if (available !== 'available') throw new Error(`--nano=real requires the production Helper audio/text JSON-review LanguageModel capability (reported ${available}). No download or placeholder fallback is allowed.`);
    return available;
  } finally {
    await browser?.close();
    await fence.close();
    await new Promise(resolve => origin.close(resolve));
  }
}

// Browser-context routing is not the security boundary: this proxy also catches
// background, service-worker, offscreen, websocket and Chromium-owned requests.
export async function startNetworkFence({ allowedOrigins, events = [] }) {
  const allowed = new Set(allowedOrigins.map(value => new URL(value).origin));
  const sockets = new Set();
  const deny = (url, method) => events.push({ type: 'network-denied', method, url, at: Date.now() });
  const server = createHttpServer((request, response) => {
    let url;
    try { url = new URL(request.url); } catch { response.writeHead(400).end('E2E proxy requires an absolute URL'); return; }
    if (!allowed.has(url.origin) || url.protocol !== 'http:' || ['/__e2e__/control', '/__e2e__/reset'].includes(url.pathname)) {
      deny(url.origin + url.pathname, request.method);
      response.writeHead(403, { 'content-type': 'text/plain' }).end('Babel E2E network fence: external requests are denied');
      return;
    }
    const headers = { ...request.headers, host: url.host };
    delete headers['proxy-connection']; delete headers['proxy-authorization'];
    const upstream = httpRequest(url, { method: request.method, headers }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('error', error => { if (!response.headersSent) response.writeHead(502); response.end(error.message); });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('connect', (request, socket) => {
    // No external TLS tunnel is allowed; known service URLs are locally fulfilled before transport.
    deny(`https://${request.url}`, 'CONNECT');
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  server.on('upgrade', (request, socket, head) => {
    let url;
    try { url = new URL(request.url); } catch { socket.destroy(); return; }
    const origin = url.origin.replace(/^ws:/, 'http:');
    if (url.protocol !== 'ws:' || !allowed.has(origin)) { deny(url.origin + url.pathname, 'UPGRADE'); socket.destroy(); return; }
    const upstream = connect(Number(url.port || 80), url.hostname, () => {
      const headers = Object.entries({ ...request.headers, host: url.host }).map(([key, value]) => `${key}: ${value}`).join('\r\n');
      upstream.write(`${request.method} ${url.pathname}${url.search} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  });
  server.on('connection', socket => {
    sockets.add(socket);
    // CONNECT/upgrade detach the HTTP parser's socket error listener. Own the
    // raw transport so a browser resetting a denied tunnel cannot crash a test.
    socket.on('error', error => {
      events.push({ type: 'network-socket-error', code: error.code, syscall: error.syscall, message: error.message, at: Date.now() });
      socket.destroy();
    });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  };
}

async function playwright(args, environment = {}) {
  const require = createRequire(import.meta.url);
  const cli = require.resolve('@playwright/test/cli');
  return await new Promise((resolve, reject) => {
    const env = { ...process.env, ...environment, PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS: '1' };
    // Only the in-process gateway gets the authorized provider credential, never browser workers or traces.
    delete env.OPENROUTER_API_KEY;
    const child = spawn(process.execPath, [cli, 'test', '--config', path.join(packageDir, 'playwright.config.mjs'), ...args], { stdio: 'inherit', env });
    const interrupt = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    child.once('error', reject);
    child.once('exit', code => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); resolve(code ?? 1); });
  });
}

export async function run(args = process.argv.slice(2)) {
  const { options, playwrightArgs } = parseOptions(args);
  if (options.help) { console.log(help); return 0; }
  const capabilityTags = getCapabilityTags(options);
  const modeEnvironment = { BABEL_E2E_MODE_OPTIONS: JSON.stringify({ ai: options.ai, browserModels: options.browserModels, nano: options.nano, speechFixtures: Boolean(options.speechFixtures) }) };
  if (capabilityTags.length) console.log(`Babel E2E local engine is ASR-only. Selected capability union: ${capabilityTags.join(' | ')}. User file/grep filters intersect this scope; no LLM fallback.`);
  if (options.list) return playwright(playwrightArgs, modeEnvironment);
  if (capabilityTags.length && await playwright([...playwrightArgs, '--list'], modeEnvironment) !== 0) {
    throw new Error(`No runnable tests or discovery failed for ${capabilityTags.join(' | ')} intersected with the supplied filters. See discovery output above.`);
  }
  await preflight(options);
  const work = await mkdtemp(path.join(tmpdir(), 'babel-extension-e2e-'));
  const artifactDir = path.join(packageDir, 'node_modules/.cache/babel-e2e', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(artifactDir, { recursive: true });
  let api, vite;
  let code = 1;
  try {
    const { materializeRecreationSnapshot } = await import('./recreation-snapshot.mjs');
    const app = await materializeRecreationSnapshot({ destinationDir: path.join(work, 'recreation') });
    await linkDependencies(path.join(packageDir, 'fixtures/recreation/app/node_modules'), path.join(app.directory, 'node_modules'));
    const extensions = await buildExtensions({ directory: work, browserModels: options.browserModels });
    const nanoCapability = options.nano === 'real' ? await assertNanoAvailable(options, work) : undefined;
    const { startScenarioServer } = await import('./server.mjs');
    api = await startScenarioServer({
      ...options, port: 0,
      assertBrowserModels: () => validateBrowserModelDirectory(options.browserModelDir),
      assertNano: () => {
        if (nanoCapability !== 'available') throw new Error('Real Nano preflight did not succeed.');
        return nanoCapability;
      }
    });
    const requireApp = createRequire(path.join(app.directory, 'package.json'));
    const viteEntry = path.join(path.dirname(requireApp.resolve('vite/package.json')), 'dist/node/index.js');
    const { build, preview } = await import(pathToFileURL(viteEntry).href);
    const previousApi = process.env.BABEL_E2E_API_URL;
    process.env.BABEL_E2E_API_URL = api.url;
    try {
      await build({ root: app.directory, mode: 'production', clearScreen: false });
      vite = await preview({ root: app.directory, mode: 'production', preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false } });
    } finally {
      if (previousApi === undefined) delete process.env.BABEL_E2E_API_URL;
      else process.env.BABEL_E2E_API_URL = previousApi;
    }
    const baseURL = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const identity = await fetch(`${baseURL}/__e2e__/state`);
    if (!identity.ok || !(await identity.json()).scenario) throw new Error('Recreation scenario proxy readiness failed; refusing to launch against an unrelated server.');
    const descriptor = path.join(work, 'run.json');
    await writeFile(descriptor, JSON.stringify({ ...options, baseURL, apiURL: api.url, extensions, work, artifactDir }));
    console.log(`Babel E2E: ${baseURL}; AI=${options.ai}; ONNX=${options.browserModels}; Nano=${options.nano}`);
    code = await playwright(playwrightArgs, { BABEL_E2E_RUN: descriptor, BABEL_E2E_OUTPUT: artifactDir });
    return code;
  } finally {
    const closePreview = vite ? new Promise((resolve, reject) => {
      vite.httpServer.close(error => error ? reject(error) : resolve());
      vite.httpServer.closeAllConnections();
    }) : undefined;
    const closed = await Promise.allSettled([closePreview, api?.close()]);
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (code === 0) await rm(artifactDir, { recursive: true, force: true });
    else console.error(`Failure artifacts: ${artifactDir}`);
    const errors = closed.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'E2E service teardown failed.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().then(code => { process.exitCode = code; }, error => { console.error(`Babel E2E: ${error.stack ?? error.message}`); process.exitCode = 1; });
}
