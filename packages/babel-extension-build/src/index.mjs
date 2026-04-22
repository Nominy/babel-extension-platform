import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createDeflateRaw } from 'node:zlib';
import { build, context } from 'esbuild';

const DEFAULT_ENV_FILES = ['.env.cws.local', '.env.local', '.env', 'data-deploy'];

export function getDefaultEnvFiles() {
  return [...DEFAULT_ENV_FILES];
}

export async function loadCwsEnvironment(rootDir, explicitFilePath) {
  const filePath = explicitFilePath
    ? resolve(rootDir, explicitFilePath)
    : await findFirstReadableFile(rootDir, DEFAULT_ENV_FILES);

  if (!filePath) {
    return {
      filePath: null,
      format: null,
      values: { ...process.env }
    };
  }

  const source = await readFile(filePath, 'utf8');
  const format = looksLikeLegacyDeployData(source) ? 'legacy-deploy-data' : 'dotenv';
  const parsedValues = format === 'dotenv' ? parseDotenv(source) : parseLegacyDeployData(source);
  const values = { ...process.env, ...parsedValues };

  for (const [key, value] of Object.entries(parsedValues)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }

  return { filePath, format, values };
}

export function parseItemUrl(itemUrl, label = 'CWS item URL') {
  let url;
  try {
    url = new URL(itemUrl);
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const match = url.pathname.match(/\/v2\/publishers\/([^/]+)\/items\/([^/]+)/);
  if (!match) {
    throw new Error(`Unexpected Chrome Web Store item URL in ${label}: ${itemUrl}`);
  }

  return {
    publisherId: decodeURIComponent(match[1]),
    extensionId: decodeURIComponent(match[2])
  };
}

export function defineExtensionBuild(config) {
  return config;
}

export async function buildExtension(config) {
  const watch = Boolean(config.watch);
  const sharedOptions = {
    bundle: true,
    minify: false,
    sourcemap: true,
    target: 'chrome114',
    format: 'iife',
    logLevel: 'info',
    ...(config.sharedOptions || {})
  };
  const tasks = (config.tasks || []).map((task) => ({
    ...sharedOptions,
    ...task
  }));

  await config.prepare?.({ watch });

  if (watch) {
    const contexts = await Promise.all(tasks.map((options) => context(options)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    if (config.watchMessage) {
      console.log(config.watchMessage);
    }
    return contexts;
  }

  const results = await Promise.all(tasks.map((options) => build(options)));
  await config.afterBuild?.({ watch, results });
  return results;
}

export async function packExtension(config) {
  if (!config.skipBuild && config.buildCommand) {
    runCommand(config.buildCommand.command, config.buildCommand.args, config.rootDir);
  }

  const { entries, zipName, zipOutputDir, zipPath: explicitZipPath } = await config.collectPackResult();
  const resolvedZipOutputDir = zipOutputDir ? resolve(config.rootDir, zipOutputDir) : resolve(config.rootDir, '.artifacts');
  const zipPath = explicitZipPath ? resolve(config.rootDir, explicitZipPath) : resolve(resolvedZipOutputDir, zipName);

  console.log(`Packing ${entries.length} files...`);
  for (const entry of entries) {
    console.log(`  ${entry.rel}`);
  }

  await createZip(zipPath, entries);
  const stat = statSync(zipPath);
  console.log(`\nCreated ${zipName} (${(stat.size / 1024).toFixed(1)} KB)`);
  return { zipPath, zipName, sizeBytes: stat.size };
}

export async function runPublishCws(config) {
  const args = parseFlagArgs(process.argv.slice(2));
  if (args.flags.has('help')) {
    printPublishHelp(config.usageZipLine);
    process.exit(0);
  }

  const envFile = args.values.get('env-file') ?? args.values.get('file');
  const loaded = await loadCwsEnvironment(config.rootDir, envFile);
  const manifest = await readManifest(resolve(config.rootDir, config.manifestPath ?? 'manifest.json'));
  const zipPath = resolve(
    config.rootDir,
    args.values.get('zip') ?? process.env.CWS_ZIP_PATH ?? config.defaultZipPath(manifest.version)
  );
  const publishType = normalizePublishType(args.values.get('publish-type') ?? process.env.CWS_PUBLISH_TYPE ?? 'DEFAULT_PUBLISH');
  const skipReview = parseBoolean(args.values.get('skip-review') ?? process.env.CWS_SKIP_REVIEW ?? 'false');
  const pollIntervalMs = parsePositiveInteger(
    args.values.get('poll-interval-ms') ?? process.env.CWS_POLL_INTERVAL_MS ?? '5000',
    'poll interval'
  );
  const pollTimeoutMs = parsePositiveInteger(
    args.values.get('poll-timeout-ms') ?? process.env.CWS_POLL_TIMEOUT_MS ?? '120000',
    'poll timeout'
  );

  const itemTarget = resolveItemTarget(loaded.filePath);
  await ensureReadableFile(zipPath);

  console.log(`Preparing Chrome Web Store upload for ${itemTarget.extensionId} (${manifest.version})`);
  console.log(`ZIP: ${zipPath}`);

  const accessToken = await getAccessToken();
  const uploadUrl = createUploadUrl(itemTarget.publisherId, itemTarget.extensionId);
  const publishUrl = createPublishUrl(itemTarget.publisherId, itemTarget.extensionId);
  const statusUrl = createStatusUrl(itemTarget.publisherId, itemTarget.extensionId);
  const zipBuffer = await readFile(zipPath);

  const uploadResult = await requestJson(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/zip'
    },
    body: zipBuffer
  });
  ensureApiSuccess(uploadResult, 'upload');

  const finalUploadResult = await waitForUploadIfNeeded(uploadResult, accessToken, statusUrl, pollIntervalMs, pollTimeoutMs);
  ensureApiSuccess(finalUploadResult, 'upload status');

  console.log(`Upload response:\n${formatJson(finalUploadResult)}`);

  const publishBody = {};
  if (publishType !== 'DEFAULT_PUBLISH') {
    publishBody.publishType = publishType;
  }
  if (skipReview) {
    publishBody.skipReview = true;
  }

  const publishHeaders = {
    Authorization: `Bearer ${accessToken}`
  };
  const publishOptions = {
    method: 'POST',
    headers: publishHeaders
  };

  if (Object.keys(publishBody).length > 0) {
    publishHeaders['Content-Type'] = 'application/json';
    publishOptions.body = JSON.stringify(publishBody);
  }

  const publishResult = await requestJson(publishUrl, publishOptions);
  ensureApiSuccess(publishResult, 'publish');

  console.log(`Publish response:\n${formatJson(publishResult)}`);
  console.log('Chrome Web Store publish request completed successfully.');

  function resolveItemTarget(sourceLabel) {
    const itemUrl = process.env.CWS_ITEM_URL?.trim();
    if (itemUrl) {
      return parseItemUrl(itemUrl, sourceLabel ?? 'CWS_ITEM_URL');
    }

    const publisherId = process.env.CWS_PUBLISHER_ID?.trim();
    const extensionId = process.env.CWS_EXTENSION_ID?.trim();
    if (!publisherId || !extensionId) {
      throw new Error('Missing Chrome Web Store item target. Set CWS_ITEM_URL or both CWS_PUBLISHER_ID and CWS_EXTENSION_ID.');
    }

    return { publisherId, extensionId };
  }
}

export async function runSetupGithubSecrets(config) {
  const args = parseSetupArgs(process.argv.slice(2));
  if (args.flags.has('help')) {
    printSetupHelp();
    process.exit(0);
  }

  const repo = args.values.get('repo') ?? args.positionals[0];
  if (!repo) {
    throw new Error('Missing target repository. Pass OWNER/REPO as the first argument or via --repo.');
  }

  const envFile = args.values.get('env-file') ?? args.values.get('file');
  const loaded = await loadCwsEnvironment(config.rootDir, envFile);
  const values = loaded.values;
  const itemUrl = values.CWS_ITEM_URL?.trim();
  const publisherId = values.CWS_PUBLISHER_ID?.trim();
  const extensionId = values.CWS_EXTENSION_ID?.trim();
  const clientSecret = values.CWS_CLIENT_SECRET?.trim();
  const refreshToken = values.CWS_REFRESH_TOKEN?.trim();
  const accessToken = values.CWS_ACCESS_TOKEN?.trim();

  if (!clientSecret || !refreshToken) {
    throw new Error(
      `Missing local Chrome Web Store credentials. Expected CWS_CLIENT_SECRET and CWS_REFRESH_TOKEN in ${loaded.filePath ?? 'the environment'}.`
    );
  }

  const itemTarget =
    publisherId && extensionId
      ? { publisherId, extensionId }
      : itemUrl
        ? parseItemUrl(itemUrl, loaded.filePath ?? 'CWS_ITEM_URL')
        : null;

  if (!itemTarget) {
    throw new Error(
      `Missing Chrome Web Store item target. Set CWS_ITEM_URL or both CWS_PUBLISHER_ID and CWS_EXTENSION_ID in ${loaded.filePath ?? 'the environment'}.`
    );
  }

  const clientId = values.CWS_CLIENT_ID?.trim() ?? (await resolveClientId(accessToken, loaded.filePath));
  const secrets = {
    CWS_CLIENT_ID: clientId,
    CWS_CLIENT_SECRET: clientSecret,
    CWS_REFRESH_TOKEN: refreshToken,
    CWS_PUBLISHER_ID: itemTarget.publisherId,
    CWS_EXTENSION_ID: itemTarget.extensionId
  };

  if (accessToken) {
    secrets.CWS_ACCESS_TOKEN = accessToken;
  }

  for (const [name, value] of Object.entries(secrets)) {
    execFileSync('gh', ['secret', 'set', name, '--repo', repo], {
      input: value,
      stdio: ['pipe', 'inherit', 'inherit']
    });
    console.log(`Set ${name} on ${repo}`);
  }

  console.log('GitHub Actions secrets updated successfully.');
}

export function collectFiles(dir, base = '') {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = join(base, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, rel));
    } else {
      results.push({ full, rel });
    }
  }
  return results;
}

async function findFirstReadableFile(rootDir, candidates) {
  for (const candidate of candidates) {
    const filePath = resolve(rootDir, candidate);
    if (await isReadableFile(filePath)) {
      return filePath;
    }
  }
  return null;
}

async function isReadableFile(filePath) {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function looksLikeLegacyDeployData(source) {
  return /(^|\r?\n)\s*(secret|refresh-token|access-token|the extension|client-id)\s*:\s*($|\r?\n)/i.test(source);
}

function parseDotenv(source) {
  const result = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }
    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    let value = normalized.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const commentIndex = value.indexOf(' #');
      if (commentIndex >= 0) {
        value = value.slice(0, commentIndex).trimEnd();
      }
    }
    result[key] = value;
  }
  return result;
}

function parseLegacyDeployData(source) {
  const legacy = {};
  let currentKey = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.endsWith(':')) {
      currentKey = line.slice(0, -1).trim().toLowerCase();
      continue;
    }
    if (!currentKey) {
      continue;
    }
    legacy[currentKey] = line;
    currentKey = null;
  }

  const result = {};
  if (legacy.secret) {
    result.CWS_CLIENT_SECRET = legacy.secret;
  }
  if (legacy['refresh-token']) {
    result.CWS_REFRESH_TOKEN = legacy['refresh-token'];
  }
  if (legacy['access-token']) {
    result.CWS_ACCESS_TOKEN = legacy['access-token'];
  }
  if (legacy['client-id']) {
    result.CWS_CLIENT_ID = legacy['client-id'];
  }
  if (legacy['the extension']) {
    result.CWS_ITEM_URL = legacy['the extension'];
  }
  return result;
}

async function createZip(outPath, entries) {
  mkdirSync(dirname(outPath), { recursive: true });
  const centralHeaders = [];
  const parts = [];
  let offset = 0;
  const now = new Date();
  const { time: dosTime, date: dosDate } = dosDateTime(now);

  for (const { rel, full } of entries) {
    const raw = readFileSync(full);
    const crc = crc32(raw);
    const compressed = await deflate(raw);
    const useDeflate = compressed.length < raw.length;
    const method = useDeflate ? 8 : 0;
    const stored = useDeflate ? compressed : raw;
    const nameBytes = Buffer.from(rel.replace(/\\/g, '/'), 'utf-8');

    const local = Buffer.alloc(30 + nameBytes.length);
    writeUInt32LE(local, 0x04034b50, 0);
    writeUInt16LE(local, 20, 4);
    writeUInt16LE(local, 0, 6);
    writeUInt16LE(local, method, 8);
    writeUInt16LE(local, dosTime, 10);
    writeUInt16LE(local, dosDate, 12);
    writeUInt32LE(local, crc, 14);
    writeUInt32LE(local, stored.length, 18);
    writeUInt32LE(local, raw.length, 22);
    writeUInt16LE(local, nameBytes.length, 26);
    writeUInt16LE(local, 0, 28);
    nameBytes.copy(local, 30);
    parts.push(local, stored);

    const central = Buffer.alloc(46 + nameBytes.length);
    writeUInt32LE(central, 0x02014b50, 0);
    writeUInt16LE(central, 20, 4);
    writeUInt16LE(central, 20, 6);
    writeUInt16LE(central, 0, 8);
    writeUInt16LE(central, method, 10);
    writeUInt16LE(central, dosTime, 12);
    writeUInt16LE(central, dosDate, 14);
    writeUInt32LE(central, crc, 16);
    writeUInt32LE(central, stored.length, 20);
    writeUInt32LE(central, raw.length, 24);
    writeUInt16LE(central, nameBytes.length, 28);
    writeUInt16LE(central, 0, 30);
    writeUInt16LE(central, 0, 32);
    writeUInt16LE(central, 0, 34);
    writeUInt16LE(central, 0, 36);
    writeUInt32LE(central, 0, 38);
    writeUInt32LE(central, offset, 42);
    nameBytes.copy(central, 46);
    centralHeaders.push(central);

    offset += local.length + stored.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const central of centralHeaders) {
    parts.push(central);
    centralSize += central.length;
  }

  const eocd = Buffer.alloc(22);
  writeUInt32LE(eocd, 0x06054b50, 0);
  writeUInt16LE(eocd, 0, 4);
  writeUInt16LE(eocd, 0, 6);
  writeUInt16LE(eocd, entries.length, 8);
  writeUInt16LE(eocd, entries.length, 10);
  writeUInt32LE(eocd, centralSize, 12);
  writeUInt32LE(eocd, centralStart, 16);
  writeUInt16LE(eocd, 0, 20);
  parts.push(eocd);

  writeFileSync(outPath, Buffer.concat(parts));
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: day };
}

function writeUInt32LE(buf, val, off) {
  buf.writeUInt32LE(val >>> 0, off);
}

function writeUInt16LE(buf, val, off) {
  buf.writeUInt16LE(val & 0xffff, off);
}

async function deflate(data) {
  const chunks = [];
  const deflater = createDeflateRaw({ level: 9 });
  deflater.on('data', (chunk) => chunks.push(chunk));
  deflater.end(data);
  await new Promise((resolvePromise, rejectPromise) => {
    deflater.on('end', resolvePromise);
    deflater.on('error', rejectPromise);
  });
  return Buffer.concat(chunks);
}

function parseFlagArgs(argv) {
  const values = new Map();
  const flags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) {
      throw new Error(`Unexpected argument: ${entry}`);
    }
    const trimmed = entry.slice(2);
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex >= 0) {
      values.set(trimmed.slice(0, equalsIndex), trimmed.slice(equalsIndex + 1));
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.add(trimmed);
      continue;
    }

    values.set(trimmed, next);
    index += 1;
  }

  return { values, flags };
}

function parseSetupArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) {
      positionals.push(entry);
      continue;
    }
    const trimmed = entry.slice(2);
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex >= 0) {
      values.set(trimmed.slice(0, equalsIndex), trimmed.slice(equalsIndex + 1));
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.add(trimmed);
      continue;
    }
    values.set(trimmed, next);
    index += 1;
  }

  return { values, flags, positionals };
}

function printPublishHelp(usageZipLine) {
  console.log(`Usage: node scripts/publish-cws.mjs [options]

Options:
  --zip PATH               ZIP to upload. Defaults to ${usageZipLine}
  --env-file PATH          Local dotenv file. Defaults to first readable file in:
                           ${getDefaultEnvFiles().join(', ')}
  --file PATH              Alias for --env-file
  --publish-type TYPE      DEFAULT_PUBLISH or STAGED_PUBLISH
  --skip-review            Request skipReview=true
  --poll-interval-ms N     Upload-status polling interval in milliseconds
  --poll-timeout-ms N      Upload-status polling timeout in milliseconds
  --help                   Show this help
`);
}

function printSetupHelp() {
  console.log(`Usage: node scripts/setup-github-secrets.mjs OWNER/REPO [options]

Options:
  --repo OWNER/REPO   Target GitHub repository
  --env-file PATH     Local dotenv file
  --file PATH         Alias for --env-file
  --help              Show this help
`);
}

async function readManifest(manifestPath) {
  const raw = await readFile(manifestPath, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

async function ensureReadableFile(filePath) {
  try {
    await access(filePath, constants.R_OK);
  } catch (error) {
    throw new Error(`Cannot read ZIP file at ${filePath}. Run "npm run build:zip" first or pass --zip PATH.\n${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getAccessToken() {
  const clientId = process.env.CWS_CLIENT_ID?.trim();
  const clientSecret = process.env.CWS_CLIENT_SECRET?.trim();
  const refreshToken = process.env.CWS_REFRESH_TOKEN?.trim();

  if (clientId && clientSecret && refreshToken) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });

    const tokenResult = await requestJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    const accessToken = tokenResult?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error(`Google token endpoint did not return an access token.\n${formatJson(tokenResult)}`);
    }

    return accessToken;
  }

  const accessToken = process.env.CWS_ACCESS_TOKEN?.trim();
  if (accessToken) {
    console.warn('Using CWS_ACCESS_TOKEN directly. This is short-lived; prefer refresh credentials.');
    return accessToken;
  }

  throw new Error('Missing Chrome Web Store authentication.');
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${url} failed with ${response.status} ${response.statusText}.\n${formatJson(payload ?? text)}`);
  }

  return payload ?? {};
}

async function waitForUploadIfNeeded(initialResult, accessToken, statusUrl, intervalMs, timeoutMs) {
  const initialState = findDeepProperty(initialResult, 'uploadState');
  if (initialState !== 'UPLOAD_IN_PROGRESS') {
    return initialResult;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
    const statusResult = await requestJson(statusUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    const uploadState = findDeepProperty(statusResult, 'uploadState');
    if (uploadState !== 'UPLOAD_IN_PROGRESS') {
      return statusResult;
    }
  }

  throw new Error(`Timed out after ${timeoutMs}ms while waiting for Chrome Web Store upload processing.`);
}

function createUploadUrl(publisherId, extensionId) {
  return `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${extensionId}?publisherId=${encodeURIComponent(publisherId)}`;
}

function createPublishUrl(publisherId, extensionId) {
  return `https://chromewebstore.googleapis.com/v1.1/items/${extensionId}:publish?publisherId=${encodeURIComponent(publisherId)}`;
}

function createStatusUrl(publisherId, extensionId) {
  return `https://chromewebstore.googleapis.com/v1.1/items/${extensionId}?publisherId=${encodeURIComponent(publisherId)}`;
}

function normalizePublishType(value) {
  return String(value || 'DEFAULT_PUBLISH').trim().toUpperCase() === 'STAGED_PUBLISH' ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH';
}

function parseBoolean(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function parsePositiveInteger(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric)) {
    throw new Error(`Expected a positive integer for ${label}, got: ${value}`);
  }
  return numeric;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatJson(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function ensureApiSuccess(payload, label) {
  const itemError = findDeepProperty(payload, 'itemError');
  if (itemError) {
    throw new Error(`Chrome Web Store ${label} failed.\n${formatJson(itemError)}`);
  }
}

function findDeepProperty(node, targetKey) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findDeepProperty(entry, targetKey);
      if (found != null) {
        return found;
      }
    }
    return null;
  }
  if (targetKey in node) {
    return node[targetKey];
  }
  for (const value of Object.values(node)) {
    const found = findDeepProperty(value, targetKey);
    if (found != null) {
      return found;
    }
  }
  return null;
}

async function resolveClientId(accessToken, sourceLabel) {
  if (!accessToken) {
    throw new Error(`Missing CWS_CLIENT_ID and CWS_ACCESS_TOKEN in ${sourceLabel ?? 'the environment'}.`);
  }

  const url = new URL('https://www.googleapis.com/oauth2/v1/tokeninfo');
  url.searchParams.set('access_token', accessToken);
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Unable to recover the OAuth client ID from the current access token.\n${JSON.stringify(payload, null, 2)}`);
  }

  const clientId = payload.issued_to;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new Error('Google token info did not return "issued_to".');
  }
  return clientId;
}

function resolveExecutable(command) {
  if (process.platform === 'win32' && command === 'npm') {
    return 'npm.cmd';
  }
  return command;
}

function runCommand(command, args, cwd) {
  const executable = resolveExecutable(command);
  if (process.platform === 'win32' && executable.endsWith('.cmd')) {
    execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', executable, ...args], {
      cwd,
      stdio: 'inherit'
    });
    return;
  }

  execFileSync(executable, args, {
    cwd,
    stdio: 'inherit'
  });
}
