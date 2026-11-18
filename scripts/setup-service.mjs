// Prepares the Python song service (run by `npm install` and `npm run setup`):
//  1. installs its packages with uv, the neural networks included (several GB the first time);
//  2. downloads the two separation models into service/.models/ (about 800 MB).
// Never fails the install: the amp works without the service, so problems only print advice.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUv, UV_MISSING_TEXT } from './uv.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uv = findUv();
if (!uv) {
  console.warn(UV_MISSING_TEXT);
  process.exit(0);
}

const run = (args) =>
  spawnSync(uv, args, { cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } }).status === 0;

/**
 * The PyTorch build for this computer: `cuda` with an NVIDIA card that CUDA 13 supports (driver 580+,
 * compute capability 7.5+), `cpu` otherwise. The same check as kv_service/components.py.
 */
function torchGroup() {
  const smi = spawnSync('nvidia-smi', ['--query-gpu=driver_version,compute_cap', '--format=csv,noheader'], {
    encoding: 'utf8',
  });
  if (smi.status !== 0 || !smi.stdout) return 'cpu';
  const fits = smi.stdout.split(/\r?\n/).some((line) => {
    const [driver, compute] = line.split(',').map((part) => part.trim());
    return Number.parseInt(driver, 10) >= 580 && Number.parseFloat(compute) >= 7.5;
  });
  return fits ? 'cuda' : 'cpu';
}

const torch = torchGroup();
console.log(`[setup] Сервис песен: ставлю библиотеки (PyTorch: ${torch}; в первый раз — несколько гигабайт)…`);
// The groups every time: a plain `uv sync` would remove the neural networks again. `roformer` is
// BS-RoFormer, this copy's own separation model (it comes from git; the installed app has only Demucs).
if (!run(['sync', '--project', 'service', '--group', 'ml', '--group', torch, '--group', 'roformer'])) {
  console.warn('[setup] Библиотеки сервиса не поставились. Проверь интернет и запусти npm run setup ещё раз.');
  process.exit(0);
}
run(['run', '--no-sync', '--project', 'service', 'python', '-m', 'kv_service.fetch_models']);
