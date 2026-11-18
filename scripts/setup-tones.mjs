// Prepares static audio assets in public/ (both are git-ignored):
//  1. Copies the NAM engine (worklet + wasm) from node_modules to public/nam/.
//  2. Downloads the TONE3000 demo amp models and cabinet/reverb IRs (MIT) and six captures of real
//     amps from a community collection (GPL-3.0) to public/tones/.
//  3. Downloads the sounds of tab-songs (FluidR3 Mono, MIT, 24 MB) to public/tones/soundfont/.
// Safe to run many times: existing downloads are kept. Network errors only warn.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');
const log = (...args) => {
  if (!quiet) console.log(...args);
};

// Pinned to the 3.0.7 release commit so the files never change under us.
const REPO_COMMIT = 'ea8dc285462d6cedd982691b9f090cd03dac04a2';
const BASE = `https://raw.githubusercontent.com/tone-3000/neural-amp-modeler-wasm/${REPO_COMMIT}/ui/public`;
const MODELS = ['jc', 'jcm', 'ac10', 'deluxe-a2', 'dumble', '5153'];
const IRS = ['celestion', 'mesa', 'eminence', 'spring', 'plate'];

// Captures of real amps from the community collection github.com/pelennor2170/NAM_models (GPL-3.0),
// pinned to a commit and checked by SHA-256: the presets are levelled for exactly these files.
// Chosen 2026-11-16 (the author did not like the first amps).
const COLLECTION_COMMIT = '944ca6718581c60cc5365586d2f378d740e181f3';
const COLLECTION_BASE = `https://raw.githubusercontent.com/pelennor2170/NAM_models/${COLLECTION_COMMIT}`;
const COLLECTION_MODELS = [
  { id: 'twin', file: 'Tim R Fender TwinVerb Norm Bright.nam', sha256: '6146d1758ddab94c529dba77f1feda8b804051f0e19117086a58db6b73b2e46b' },
  { id: 'jcm2000', file: 'Tim R JCM2000 Crunch.nam', sha256: 'd687c5829ae246a36d573d705bd296e8c26be48385f2948edf2db67f2ba67e87' },
  { id: 'jcm900', file: 'Tim R JCM90050WDualVerbChBG12.nam', sha256: '7cfcda985d14a9b0fe11bd93ad2903c619ca568d8edc7cbf3fc718bd50202dfb' },
  { id: 'shirley', file: 'Sascha S DirtyShirleyMini_crunch_G8.nam', sha256: '4905ab23ddf3f22e84b9811104bd77501d07d3437761307288d8e8b99b0e0a8f' },
  { id: 'ac15', file: 'Phillipe P VOXAC15-TopBoost.nam', sha256: '382d0bb88d1b6ee59aa9413ec5a419df857abe8c3b9f7d269221463d9daa6e14' },
  { id: '5150', file: 'Helga B 5150 BlockLetter - NoBoost.nam', sha256: 'eb5074a3288d214bc446d526c1e636271aec587b0c64009538be037b62e7ab9e' },
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyEngine() {
  const src = join(root, 'node_modules', 'neural-amp-modeler-wasm', 'dist', 'engine');
  const dst = join(root, 'public', 'nam');
  if (!(await exists(src))) {
    console.warn('[setup] NAM engine not found in node_modules yet — run "npm install".');
    return;
  }
  await mkdir(dst, { recursive: true });
  for (const file of ['nam-worklet.js', 'nam-engine.wasm']) {
    await copyFile(join(src, file), join(dst, file));
  }
  log('[setup] NAM engine copied to public/nam/');
  await translateForWasmtime(dst);
}

/**
 * The fast guitar engine (service/src/kv_guitar) runs the same wasm in wasmtime, which only knows
 * the new exception-handling instructions (exnref); the shipped module uses the legacy ones that
 * browsers accept. binaryen's wasm-opt rewrites a copy once. Skipped when the copy is up to date.
 */
const WASM_FEATURES = [
  '--enable-sign-ext',
  '--enable-mutable-globals',
  '--enable-nontrapping-float-to-int',
  '--enable-simd',
  '--enable-bulk-memory',
  '--enable-bulk-memory-opt',
  '--enable-exception-handling',
  '--enable-reference-types',
  '--enable-multivalue',
];

async function translateForWasmtime(namDir) {
  const src = join(namDir, 'nam-engine.wasm');
  const dst = join(namDir, 'nam-engine.exnref.wasm');
  const wasmOpt = join(root, 'node_modules', 'binaryen', 'bin', 'wasm-opt');
  // Compared with the package's file: the copy in public/nam/ is refreshed on every `npm run dev`.
  const packaged = join(root, 'node_modules', 'neural-amp-modeler-wasm', 'dist', 'engine', 'nam-engine.wasm');
  if ((await exists(dst)) && (await stat(dst)).mtimeMs >= (await stat(packaged)).mtimeMs) return;
  if (!(await exists(wasmOpt))) {
    console.warn('[setup] binaryen not found — run "npm install" (needed for the fast guitar sound).');
    return;
  }
  const result = spawnSync(
    process.execPath,
    // Only the features the module uses: `--all-features` would also emit encodings (compact
    // imports) that wasmtime 50 cannot parse.
    [wasmOpt, src, ...WASM_FEATURES, '--translate-to-exnref', '-o', dst],
    { stdio: quiet ? 'ignore' : 'inherit' },
  );
  if (result.status === 0) log('[setup] NAM engine translated for the fast guitar sound (nam-engine.exnref.wasm).');
  else console.warn('[setup] Could not translate the NAM engine for the fast guitar sound; the browser sound still works.');
}

// The sounds of tab-songs (2026-11-16): FluidR3 Mono GM as MuseScore ships it (Frank Wen, Michael Cowgill,
// S. Christian Collins; MIT), from MuseScore's repository at the commit of tag v4.4.4. alphaTab's own Sonivox
// (1.4 MB, samples at 11–22 kHz) stays as the fallback.
const SOUNDFONT_COMMIT = '22326704eef99117039391decab233a8b1c2ae19';
const SOUNDFONT_BASE = `https://raw.githubusercontent.com/musescore/MuseScore/${SOUNDFONT_COMMIT}/share/sound`;
const SOUNDFONT_SHA256 = '2aacd036d7058d40a371846ef2f5dc5f130d648ab3837fe2626591ba49a71254';
// What `fluidSynthAttenuation` makes of it: the file the app loads.
const SOUNDFONT_APP_SHA256 = '8c262f57e1937e076a4408ebf7a120d07df87de5f9731b087dca53d627124010';
export const SOUNDFONT_FILE = 'fluidr3-mono.sf3';

/**
 * FluidR3 was balanced in FluidSynth, which plays every «initial attenuation» at 0.4 of its value
 * (as the E-mu cards did). alphaTab's synthesizer (TinySoundFont) plays it in full: measured on
 * the author's tabs, the bass came out 17 dB under the drums and the guitars 10–15 dB too quiet.
 * So the file's attenuation generators (number 48, in the preset and the instrument zones) are
 * scaled by 0.4 here, once: the balance is FluidSynth's again (bass −4 … +1 dB to the drums).
 */
export function fluidSynthAttenuation(bytes) {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const tag = (at) => String.fromCharCode(...out.subarray(at, at + 4));
  const chunks = (start, end, visit) => {
    for (let at = start; at + 8 <= end; ) {
      const size = view.getUint32(at + 4, true);
      visit(tag(at), at + 8, size);
      at += 8 + size + (size & 1);
    }
  };
  let scaled = 0;
  chunks(12, out.length, (id, at, size) => {
    if (id !== 'LIST' || tag(at) !== 'pdta') return;
    chunks(at + 4, at + size, (sub, from, length) => {
      if (sub !== 'pgen' && sub !== 'igen') return;
      for (let rec = from; rec + 4 <= from + length; rec += 4) {
        const amount = view.getInt16(rec + 2, true);
        if (view.getUint16(rec, true) === 48 && amount !== 0) {
          view.setInt16(rec + 2, Math.round(amount * 0.4), true);
          scaled++;
        }
      }
    });
  });
  if (!scaled) throw new Error('no attenuation found: not the expected soundfont');
  return out;
}

function looksValid(file, bytes) {
  if (file.endsWith('.sf3') || file.endsWith('.sf2')) {
    const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
    return bytes.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'sfbk';
  }
  if (file.endsWith('.wav')) {
    // Compare raw bytes: decoding the header as UTF-8 breaks on the binary size field.
    const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
    return bytes.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
  }
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes));
    return typeof json === 'object' && json !== null && typeof json.architecture === 'string';
  } catch {
    return false;
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** `url` → `localPath`, kept when already there (and, with `expectedSha`, still the same file). */
async function download(url, localPath, expectedSha = null) {
  if (await exists(localPath)) {
    if (!expectedSha || sha256(await readFile(localPath)) === expectedSha) return 'kept';
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!looksValid(localPath, bytes)) throw new Error('unexpected file contents');
  if (expectedSha && sha256(bytes) !== expectedSha) throw new Error('the file changed (SHA-256 does not match)');
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, bytes);
  return 'downloaded';
}

/** The tab-songs' soundfont (24 MB): downloaded once, checked, its attenuation scaled. */
async function downloadTabSoundFont() {
  const dir = join(root, 'public', 'tones', 'soundfont');
  const local = join(dir, SOUNDFONT_FILE);
  try {
    if ((await exists(local)) && sha256(await readFile(local)) === SOUNDFONT_APP_SHA256) return;
    // Shown even with --quiet (npm run dev runs this first): a one-time wait of some seconds.
    console.log('[setup] Скачиваю звуки для песен из табов (24 МБ, один раз)…');
    const response = await fetch(`${SOUNDFONT_BASE}/FluidR3Mono_GM.sf3`, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!looksValid(local, bytes) || sha256(bytes) !== SOUNDFONT_SHA256) throw new Error('the file changed (SHA-256 does not match)');
    const ready = fluidSynthAttenuation(bytes);
    if (sha256(ready) !== SOUNDFONT_APP_SHA256) throw new Error('the rescaled file is not the expected one');
    const license = await fetch(`${SOUNDFONT_BASE}/FluidR3Mono_License.md`, { signal: AbortSignal.timeout(60_000) });
    await mkdir(dir, { recursive: true });
    if (license.ok) await writeFile(join(dir, 'FluidR3Mono_License.md'), await license.text());
    await writeFile(local, ready);
    log('[setup] Sounds for tab-songs ready in public/tones/soundfont/.');
  } catch (error) {
    console.warn(`[setup] Could not get the sounds for tab-songs (${error.message}); they play with the small built-in set.`);
  }
}

async function downloadTones() {
  const tonesDir = join(root, 'public', 'tones');
  const jobs = [
    ...MODELS.map((name) => [`${BASE}/models/${name}.nam`, join(tonesDir, 'models', `${name}.nam`), null]),
    ...IRS.map((name) => [`${BASE}/irs/${name}.wav`, join(tonesDir, 'irs', `${name}.wav`), null]),
    ...COLLECTION_MODELS.map((m) => [
      `${COLLECTION_BASE}/${encodeURIComponent(m.file)}`,
      join(tonesDir, 'models', `${m.id}.nam`),
      m.sha256,
    ]),
  ];
  let failed = 0;
  let downloaded = 0;
  for (const [url, local, expectedSha] of jobs) {
    try {
      if ((await download(url, local, expectedSha)) === 'downloaded') downloaded++;
    } catch (error) {
      failed++;
      console.warn(`[setup] Could not download ${url}: ${error.message}`);
    }
  }
  await mkdir(tonesDir, { recursive: true });
  await writeFile(
    join(tonesDir, 'ATTRIBUTION.txt'),
    'Demo amp models (.nam) and impulse responses (.wav) from TONE3000,\n' +
      `https://github.com/tone-3000/neural-amp-modeler-wasm (commit ${REPO_COMMIT}), MIT License.\n\n` +
      'Amp captures from the community collection https://github.com/pelennor2170/NAM_models\n' +
      `(commit ${COLLECTION_COMMIT}), GNU GPL v3; captured by Tim R, Phillipe P, Sascha S and Helga B:\n` +
      COLLECTION_MODELS.map((m) => `  ${m.id}.nam = ${m.file}\n`).join('') +
      '\nSounds for tab-songs: soundfont/fluidr3-mono.sf3 = FluidR3Mono_GM.sf3 from MuseScore\n' +
      `(https://github.com/musescore/MuseScore, commit ${SOUNDFONT_COMMIT}), MIT License (see\n` +
      'soundfont/FluidR3Mono_License.md): Frank Wen 2000-2002, Michael Cowgill 2014-17, S. Christian\n' +
      'Collins 2018. Its attenuation generators are scaled by 0.4, as FluidSynth plays them.\n',
  );
  if (failed) {
    console.warn(`[setup] ${failed} tone file(s) missing. Check the internet connection and run "npm run setup".`);
  } else {
    log(`[setup] Tones ready in public/tones/ (${downloaded} downloaded now).`);
  }
}

// Run as a script (npm run setup); imported (a test), it only lends its functions.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await copyEngine();
  await downloadTones();
  await downloadTabSoundFont();
}
