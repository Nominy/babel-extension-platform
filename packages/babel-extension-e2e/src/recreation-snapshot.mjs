import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
export const defaultSnapshotDir = resolve(packageDir, 'fixtures/recreation');
const defaultSourceDir = resolve(packageDir, '../../../../tools/babel-editor-rebuild/app');
const schemaVersion = 1;
const roots = ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tailwind.config.js', 'postcss.config.js', 'src/main.tsx', 'src/recovered/generated/adapterMapping.json'];
const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const forbidden = /(?:^|\/)(?:node_modules|\.git|exports|fixture|fixtures|artifacts|probes?|babel_experiment|ported|source)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:wav|mp3|mp4|ogg|flac|webm|log|map)$/i;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function safePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').some((part) => !part || part === '.' || part === '..') || forbidden.test(path)) {
    throw new Error(`Snapshot rejects unsafe or private-data path: ${path}`);
  }
  return path;
}

async function regularFile(root, path) {
  safePath(path);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Snapshot root must be a real directory: ${root}`);
  let current = root;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Snapshot rejects symlink: ${path}`);
  }
  if (!(await lstat(current)).isFile()) throw Object.assign(new Error(`Snapshot requires a regular file: ${path}`), { code: 'EISDIR' });
  return readFile(current);
}

function validateDependencies(pkg, lock) {
  if (pkg.private !== true || lock.lockfileVersion !== 3 || !lock.packages?.['']) {
    throw new Error('Recreation must be private with an npm lockfileVersion 3 lockfile.');
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const declared = pkg[field] ?? {};
    const locked = lock.packages[''][field] ?? {};
    if (JSON.stringify(Object.entries(declared).sort()) !== JSON.stringify(Object.entries(locked).sort())) {
      throw new Error(`Recreation package-lock.json is stale: ${field} differs.`);
    }
    for (const [name, version] of Object.entries(declared)) {
      if (/^(?:file:|link:|workspace:|git|https?:|\.\.?[\\/])/.test(version) || !lock.packages[`node_modules/${name}`]) {
        throw new Error(`Recreation dependency must be registry-locked: ${name}@${version}`);
      }
    }
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (!path.startsWith('node_modules/') || entry.link || !entry.version || !entry.integrity || !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved ?? '')) {
      throw new Error(`Recreation dependency lacks portable registry integrity: ${path}`);
    }
  }
  for (const name of ['react', 'react-dom', 'typescript', 'vite', '@vitejs/plugin-react', 'tailwindcss', 'postcss', 'autoprefixer']) {
    if (!pkg.dependencies?.[name] && !pkg.devDependencies?.[name]) throw new Error(`Missing rendering dependency: ${name}`);
  }
}

async function resolveInput(root, importer, specifier) {
  const clean = specifier.split(/[?#]/, 1)[0];
  const base = clean.startsWith('/') ? clean.slice(1) : relative(root, resolve(root, dirname(importer), clean)).split(sep).join('/');
  safePath(base);
  const candidates = [base, ...codeExtensions.map((extension) => `${base}${extension}`), `${base}.json`, ...codeExtensions.map((extension) => `${base}/index${extension}`)];
  if (clean.startsWith('/')) candidates.push(`public/${base}`);
  for (const candidate of candidates) {
    try {
      const bytes = await regularFile(root, candidate);
      return { path: candidate, bytes };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error(`Missing required recreation input: ${specifier} imported by ${importer}`);
}

function moduleReferences(ts, path, text) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const references = [];
  const addLiteral = (node) => {
    if (!node || !ts.isStringLiteralLike(node)) throw new Error(`Non-static module/asset import cannot be snapshotted: ${path}`);
    references.push(node.text);
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) addLiteral(node.moduleSpecifier);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) addLiteral(node.arguments[0]);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[1]?.getText(file) === 'import.meta.url') addLiteral(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return references;
}

function assetReferences(path, text, postcss, valueParser) {
  let references;
  if (extname(path) === '.html') {
    references = [...text.matchAll(/<(?:script|link|img|source)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  } else if (extname(path) === '.css') {
    references = [];
    const collect = (value, isImport = false) => {
      const parsed = valueParser(value);
      const first = parsed.nodes.find((node) => node.type !== 'space' && node.type !== 'comment');
      if (isImport && first?.type === 'string') references.push(first.value);
      parsed.walk((node) => {
        if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
        const parts = node.nodes.filter((part) => part.type !== 'space' && part.type !== 'comment');
        if (node.unclosed || parts.length !== 1 || !['word', 'string'].includes(parts[0].type)) throw new Error(`Invalid static CSS URL in ${path}`);
        references.push(parts[0].value);
        // A quoted data URI is one URL, not more CSS containing nested url(...).
        return false;
      });
    };
    const stylesheet = postcss.parse(text, { from: path });
    stylesheet.walkDecls((declaration) => collect(declaration.value));
    stylesheet.walkAtRules((rule) => {
      if (rule.name.toLowerCase() === 'import') collect(rule.params, true);
    });
  } else {
    return [];
  }
  return references.map((reference) => {
    if (/^(?:data:|#)/i.test(reference)) return reference;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) throw new Error(`Remote asset cannot be snapshotted: ${reference} in ${path}`);
    return reference.startsWith('.') || reference.startsWith('/') ? reference : `./${reference}`;
  });
}

/** Generate only after the recreation mutation barrier. Never reads browser state or task/audio fixtures. */
export async function refreshRecreationSnapshot({ sourceDir = defaultSourceDir, snapshotDir = defaultSnapshotDir, provenancePath = 'src/recovered/generated/moduleManifest.json' } = {}) {
  const source = resolve(sourceDir);
  const target = resolve(snapshotDir);
  if (target === source || target.startsWith(`${source}${sep}`) || source.startsWith(`${target}${sep}`)) throw new Error('Snapshot and source directories must not overlap.');
  const pkg = JSON.parse(await regularFile(source, 'package.json'));
  const lock = JSON.parse(await regularFile(source, 'package-lock.json'));
  validateDependencies(pkg, lock);
  const sourceRequire = createRequire(resolve(source, 'package.json'));
  const ts = sourceRequire('typescript');
  const postcss = sourceRequire('postcss');
  const valueParser = createRequire(sourceRequire.resolve('autoprefixer/package.json'))('postcss-value-parser');
  const files = new Map();
  const sourceHashes = new Map();
  const queue = [...roots, safePath(provenancePath)];
  while (queue.length) {
    const path = queue.shift();
    if (files.has(path)) continue;
    const bytes = await regularFile(source, path);
    files.set(path, bytes);
    sourceHashes.set(path, hash(bytes));
    const references = codeExtensions.includes(extname(path)) ? moduleReferences(ts, path, bytes.toString('utf8')) : assetReferences(path, bytes.toString('utf8'), postcss, valueParser);
    for (const specifier of references) {
      if (/^(?:data:|#)/i.test(specifier)) continue;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const input = await resolveInput(source, path, specifier);
        queue.push(input.path);
      } else {
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        if (specifier.startsWith('node:') || builtinModules.includes(specifier)) continue;
        if (!pkg.dependencies?.[name] && !pkg.devDependencies?.[name]) throw new Error(`Undeclared rendering import: ${specifier} in ${path}`);
      }
    }
  }
  const provenance = JSON.parse(files.get(provenancePath));
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance) || Object.keys(provenance).length === 0) throw new Error('Runtime provenance must be a populated static-code metadata object.');
  for (const [path, expectedHash] of sourceHashes) {
    if (hash(await regularFile(source, path)) !== expectedHash) throw new Error(`Recreation changed during snapshot generation: ${path}. Refresh only after the mutation barrier.`);
  }
  // CI consumes already-generated native code: no hooks may reach the ignored tools tree.
  pkg.scripts = { dev: 'vite --host 127.0.0.1', build: 'tsc --noEmit && vite build', preview: 'vite preview --host 127.0.0.1' };
  files.set('package.json', Buffer.from(json(pkg)));
  const entries = [...files].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes), sourceSha256: sourceHashes.get(path) }));
  const manifest = {
    schemaVersion,
    private: true,
    snapshotVersion: hash(json(entries)),
    provenance,
    provenancePath,
    source: 'tools/babel-editor-rebuild/app',
    policy: 'Authorized recovered static code only; synthetic tasks and audio supplied by the scenario server. No credentials, browser storage, probes, task exports, conversation audio, or node_modules.',
    transforms: { 'package.json': 'Retain locked dependencies; replace development-only scripts with standalone Vite scripts.' },
    files: entries,
  };
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(resolve(dirname(target), '.recreation-stage-'));
  let backup;
  try {
    for (const [path, bytes] of files) {
      await mkdir(dirname(resolve(stage, 'app', path)), { recursive: true });
      await writeFile(resolve(stage, 'app', path), bytes);
    }
    const manifestText = json(manifest);
    await writeFile(resolve(stage, 'manifest.json'), manifestText);
    await writeFile(resolve(stage, 'manifest.sha256'), `${hash(manifestText)}  manifest.json\n`);
    try {
      const previous = JSON.parse(await readFile(resolve(target, 'manifest.json'), 'utf8'));
      if (previous.schemaVersion !== schemaVersion || previous.private !== true) throw new Error('Refusing to replace an unrecognized snapshot directory.');
      backup = `${stage}-previous`;
      await rename(target, backup);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        if ((await readdir(target)).length) throw new Error('Refusing to replace a nonempty directory without a snapshot manifest.');
        await rm(target, { recursive: true });
      } catch (missing) {
        if (missing.code !== 'ENOENT') throw missing;
      }
    }
    await rename(stage, target);
    if (backup) await rm(backup, { recursive: true });
    return { directory: target, manifest };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (backup) {
      try { await rename(backup, target); } catch (restoreError) { error.message += `; previous snapshot retained at ${backup}: ${restoreError.message}`; }
    }
    throw error;
  }
}

/** Verify all bytes before writing a standalone app; dependency installation belongs to the runner. */
export async function materializeRecreationSnapshot({ destinationDir, snapshotDir = defaultSnapshotDir } = {}) {
  if (!destinationDir) throw new Error('materializeRecreationSnapshot requires destinationDir.');
  const source = resolve(snapshotDir);
  const destination = resolve(destinationDir);
  if (destination === source || destination.startsWith(`${source}${sep}`) || source.startsWith(`${destination}${sep}`)) throw new Error('Materialization destination must not overlap the snapshot.');
  const manifestBytes = await regularFile(source, 'manifest.json');
  const checksum = (await regularFile(source, 'manifest.sha256')).toString('utf8');
  if (checksum !== `${hash(manifestBytes)}  manifest.json\n`) throw new Error('Recreation snapshot manifest checksum mismatch.');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== schemaVersion || manifest.private !== true || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.snapshotVersion !== hash(json(manifest.files))) throw new Error('Unsupported or corrupt recreation snapshot manifest.');
  const verified = new Map();
  for (const entry of manifest.files) {
    safePath(entry.path);
    if (verified.has(entry.path)) throw new Error(`Duplicate snapshot input: ${entry.path}`);
    const bytes = await regularFile(resolve(source, 'app'), entry.path);
    if (entry.bytes !== bytes.length || entry.sha256 !== hash(bytes)) throw new Error(`Recreation snapshot checksum mismatch: ${entry.path}`);
    verified.set(entry.path, bytes);
  }
  for (const path of roots) if (!verified.has(path)) throw new Error(`Snapshot lacks required rendering input: ${path}`);
  if (!verified.has(safePath(manifest.provenancePath)) || json(JSON.parse(verified.get(manifest.provenancePath))) !== json(manifest.provenance)) throw new Error('Snapshot provenance differs from its verified native runtime manifest.');
  validateDependencies(JSON.parse(verified.get('package.json')), JSON.parse(verified.get('package-lock.json')));
  try {
    if ((await lstat(destination)).isSymbolicLink() || (await readdir(destination)).length) throw new Error('Materialization destination must be an empty real directory.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(destination, { recursive: true });
  for (const [path, bytes] of verified) {
    await mkdir(dirname(resolve(destination, path)), { recursive: true });
    await writeFile(resolve(destination, path), bytes, { flag: 'wx' });
  }
  return { directory: destination, manifest };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  const names = { 'source-dir': 'sourceDir', 'snapshot-dir': 'snapshotDir', 'destination-dir': 'destinationDir', 'provenance-path': 'provenancePath' };
  for (const arg of args) {
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match || !names[match[1]]) throw new Error(`Unknown snapshot option: ${arg}`);
    options[names[match[1]]] = match[2];
  }
  if (command !== 'refresh' && command !== 'materialize') throw new Error('Usage: recreation-snapshot.mjs refresh [--source-dir=...] [--snapshot-dir=...] | materialize --destination-dir=... [--snapshot-dir=...]');
  const result = await (command === 'refresh' ? refreshRecreationSnapshot(options) : materializeRecreationSnapshot(options));
  console.log(JSON.stringify({ directory: result.directory, snapshotVersion: result.manifest.snapshotVersion, files: result.manifest.files.length }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
