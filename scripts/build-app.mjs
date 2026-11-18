// Builds the installed app: `npm run build:app`.
//
// 1. The page: `npm run build` (typecheck + vite build) into dist/, with public/ (tones, NAM engine,
//    soundfont) copied in by Vite.
// 2. shell/resources/: web/ (the page), app/ (the service's project: pyproject, uv.lock and the code
//    of kv_service and kv_guitar), uv.exe, LICENSES.txt.
// 3. `tauri build`: shell/target/release/strum.exe and the installer
//    shell/target/release/bundle/nsis/Strum_<version>_x64-setup.exe.
//
// `--no-bundle` stops after Strum.exe (no installer): quicker for a check.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUv } from './uv.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shell = join(root, 'shell');
const resources = join(shell, 'resources');
const noBundle = process.argv.includes('--no-bundle');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// npm and npx are .cmd files on Windows, which only a shell runs: one command line, quoted.
const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

function run(command, args, cwd = root) {
  const result =
    process.platform === 'win32'
      ? spawnSync([command, ...args].map(quote).join(' '), { cwd, stdio: 'inherit', shell: true })
      : spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[build-app] ${command} ${args.join(' ')} failed`);
    process.exit(result.status ?? 1);
  }
}

// The built-in sounds and the NAM engine must be in public/ before Vite copies it.
for (const file of ['public/nam/nam-engine.exnref.wasm', 'public/tones/models/twin.nam', 'public/tones/soundfont/fluidr3-mono.sf3']) {
  if (!existsSync(join(root, file))) {
    console.error(`[build-app] ${file} is missing: run npm run setup first.`);
    process.exit(1);
  }
}

const uv = findUv();
if (!uv) {
  console.error('[build-app] uv not found: it is put into the installer.');
  process.exit(1);
}

console.log('[build-app] the page');
run(npm, ['run', 'build']);

console.log('[build-app] resources');
rmSync(resources, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
cpSync(join(root, 'dist'), join(resources, 'web'), { recursive: true });
// alphaTab's Vite plugin copies its own soundfont and font into public/ too; the app uses ours.
rmSync(join(resources, 'web', 'tones', 'soundfont', 'MS_General.sf2'), { force: true });

const app = join(resources, 'app');
mkdirSync(join(app, 'src'), { recursive: true });
for (const file of ['pyproject.toml', 'uv.lock', '.python-version']) cpSync(join(root, 'service', file), join(app, file));
const skip = (source) => !/[\\/](__pycache__|\.pytest_cache)([\\/]|$)/.test(source);
for (const pkg of ['kv_service', 'kv_guitar']) {
  cpSync(join(root, 'service', 'src', pkg), join(app, 'src', pkg), { recursive: true, filter: skip });
}
cpSync(uv, join(resources, process.platform === 'win32' ? 'uv.exe' : 'uv'));

// The PyTorch index gives no wheel sizes, and uv.lock has none for its wheels: asked here once, so
// the app can say how much «Download» will take before anything is downloaded (components.py).
const lockText = readFileSync(join(root, 'service', 'uv.lock'), 'utf8');
const sizeless = [...lockText.matchAll(/\{ url = "([^"]+\.whl)"[^}\n]*\}/g)]
  .filter((m) => !m[0].includes('size = '))
  .map((m) => m[1]);
const sizes = {};
for (const url of sizeless) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    const length = Number(response.headers.get('content-length'));
    if (response.ok && length > 0) sizes[url] = length;
  } catch {
    console.warn(`[build-app] no size for ${url}`);
  }
}
writeFileSync(join(app, 'wheel-sizes.json'), JSON.stringify(sizes, null, 1));
console.log(`[build-app] wheel sizes: ${Object.keys(sizes).length} of ${sizeless.length}`);

const attribution = existsSync(join(root, 'public', 'tones', 'ATTRIBUTION.txt'))
  ? readFileSync(join(root, 'public', 'tones', 'ATTRIBUTION.txt'), 'utf8')
  : '';
const licenses = existsSync(join(root, 'LICENSES.txt')) ? readFileSync(join(root, 'LICENSES.txt'), 'utf8') : '';
writeFileSync(join(resources, 'LICENSES.txt'), [licenses, attribution].filter(Boolean).join('\n\n'));

console.log('[build-app] Strum.exe' + (noBundle ? '' : ' and the installer'));
run(npx, ['tauri', 'build', ...(noBundle ? ['--no-bundle'] : [])], shell);
console.log(
  noBundle
    ? `[build-app] done: ${join(shell, 'target', 'release', 'strum.exe')}`
    : `[build-app] done: ${join(shell, 'target', 'release', 'bundle', 'nsis')}`,
);
