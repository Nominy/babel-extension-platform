import { access, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repositoryDir = path.resolve(packageDir, '../../../..');
const publicKeys = {
  grader: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyDUpNv455xEfmxgioSwPARuWAUwcaX8RBO6xeCpjXxSIiosurwqzFw0wTUoLipwB4tfeLi9RVv++tkgkXDlxC2NHao0YDvYZudX12rHjMPaJ4BhvJmNACLaQuq26axPYtwcOIGugpypdrWSLR1em0oui2dTsk588I8HYSIKIPK9r2UamVZDCkn+56vbYKMnNG/EoHngWXOTSjk4xDGKS+BSpG6SRtf1hkjqjsCdZaIqpsGCmjLctshbMl/gifIk0WHl6In//iQLFC/6KWwQHL1kJ8e2bDtu+rYikUB/NYvwZaDneqXVewcft9kOBVWKDQ/YaJ8rKPgEN+sTAPQEznQIDAQAB',
  helper: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlHepCdJVA3w/cRBmuENg1ySVvWj8vOWeoIf2+sHquvwtpYS0UOtbl2yj4NMgB/ySqZEApc85zja2bLkr/bYho6iqPXEtaSug+c7vi6rVTtapCavdfbMmaCVC4SJib4QngQQguzm1mbuf6VsudZRbUa/IGyRNLQKDCvz8XkQSOWIcdOHzqbDakJuDs5BRd510X6aNkK+UFPAHw8+1bc0GEHM+Ll4i2Pwj1K+v55+7PwlV6MXxt56asyXcjMDzzJLc0PGm68O6Wen+5Kr18jIcrZEBVyZ5GONBFeFWnOTUzrZsnPdmtlxvFnB0sG3YNoaiIVQpaV8pxf0qr9S0l+IHEwIDAQAB',
  gold: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtNEgg2K3nELZ0OX2Y5SXCKg8TGzeDlk5ViW1UMeHbfvS/UdxirtBtL1KMZYygYn0hF7/emdkzmsl6A0DeWHYzZ3BQAzslVVQOI3DD4aq7lraZMXxp6WxUBu2lzL+1MV4lSDejoJl6QpRDjbB+BwYegrXQeMAVqODWIU/UcccxBZDmWPNmNdZNI9qI5K57HENOroPU4zMygcmo1mzuby2pEztRjT5dkSJet/y2piBG7BRiHIIf4kwwuJK+SG4C1cpvAWr5VgQ+RrGo6gGI6uOSzQjRV7XE2mqhcLMwnblM142yZLlPduevAhbXezx5XuVXCurI8AqE6Cq305fi42HlwIDAQAB',
  review: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0JvexGi2HUjKiov5kTqjMpUDV9pEIIVDTYyJKOcBV8NL42SEmF71dTvyFTL2sL5jIeB7g+loH0foksXM2WM7mMrLmPfVePAAobGXRcrstN5fjxfwWgYuho+QW6JrhGwzqR/p9gWt7wGoSbOo4j5dA/RqobOeqvu06p7TSB0VvwukhGBfmcUo8hDwNPT9Mxx9int8EtpHi+DbWtDo9f4Ip74BgABAF98fLRpHVWsPx414QEYrQpHzbTgXezZ8pdyWvm3OLO7eHkNQlnHCZRu0rtXBxTwQaBYmwHL49zkR8bZtpU80veyhvu9UZrpfsy7C9koQ8nC7tUdF9v2ZVCtM4QIDAQAB'
};
export const extensionIds = Object.fromEntries(Object.entries(publicKeys).map(([name, key]) => [name,
  createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)))
]));
const products = {
  grader: 'reviewer/babel-review-grader-extension',
  helper: 'babel-helper-extension-repo',
  gold: 'drafting/gold-drafting-extension',
  review: 'reviewer/review-interceptor-extension'
};

export async function requirePath(filename, instruction) {
  try { await access(filename); } catch { throw new Error(`Missing ${filename}. ${instruction}`); }
}

export async function linkDependencies(source, destination) {
  await requirePath(source, 'Install the owning package dependencies first (npm ci --ignore-scripts).');
  await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
}

function compile(directory, args) {
  return new Promise((resolve, reject) => {
    // Invoke the checked-in compiler directly: never a versioning, publishing or unpacked-sync script.
    const child = spawn(process.execPath, ['esbuild.config.mjs', ...args], { cwd: directory, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Extension compiler failed (${code ?? signal}) in ${directory}`)));
  });
}

async function copyBuildInputs(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const name of ['src', 'scripts', 'assets', 'icons', 'options.html', 'manifest.json', 'package.json', 'tsconfig.json', 'esbuild.config.mjs']) {
    try { await access(path.join(source, name)); } catch { continue; }
    await cp(path.join(source, name), path.join(destination, name), { recursive: true });
  }
  await linkDependencies(path.join(source, 'node_modules'), path.join(destination, 'node_modules'));
}

async function stageManifest(name, directory) {
  const filename = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  manifest.key = publicKeys[name];
  for (const content of manifest.content_scripts ?? []) content.matches = ['http://127.0.0.1/*'];
  for (const resource of manifest.web_accessible_resources ?? []) {
    if (resource.matches) resource.matches = ['http://127.0.0.1/*'];
  }
  // Required backend permissions remain intact for the release and model URLs. Content activation is localhost-only.
  if (manifest.host_permissions) manifest.host_permissions = [...new Set([...manifest.host_permissions, 'http://127.0.0.1/*'])];
  if (name === 'gold') manifest.externally_connectable.ids = [...new Set([...manifest.externally_connectable.ids, extensionIds.helper])];
  await writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, id: extensionIds[name], options: manifest.options_page ?? manifest.options_ui?.page, manifest };
}

export async function buildExtensions({ directory, browserModels = 'placeholder', grader = false }) {
  const output = {};
  for (const [name, relative] of Object.entries(products)) {
    if (name === 'grader' && !grader) continue;
    const source = path.join(repositoryDir, relative);
    const work = path.join(directory, 'build', name);
    await copyBuildInputs(source, work);
    if (name === 'gold' && browserModels === 'placeholder') {
      const { browserInferencePlaceholderSource } = await import('./providers.mjs');
      const inference = path.join(work, 'src/core/local-model-runtime.ts');
      await writeFile(inference, browserInferencePlaceholderSource(await readFile(inference, 'utf8')));
    }
    if (name === 'review') {
      output.review = {};
      for (const flavor of ['dev', 'release']) {
        await compile(work, ['--flavor', flavor]);
        output.review[flavor] = await stageManifest(name, path.join(work, 'build', flavor));
      }
    } else {
      await compile(work, []);
      output[name] = await stageManifest(name, work);
    }
  }
  return output;
}
