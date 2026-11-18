// Runs the guitar probe (stage 4½): `npm run probe:guitar -- --minutes 2 --buffer 128 --load`.
// ASIO → NAM → cabinet → headphones in Python, with the time of every audio callback measured.
// `--dry` checks the calculation alone, without opening a sound card.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUv, UV_MISSING_TEXT } from './uv.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uv = findUv();
if (!uv) {
  console.error(UV_MISSING_TEXT);
  process.exit(1);
}

// --no-sync: the probe never installs or downloads anything (that is `npm run setup`).
const args = ['run', '--no-sync', '--project', 'service', 'python', '-m', 'kv_guitar.probe', ...process.argv.slice(2)];
const child = spawn(uv, args, {
  cwd: root,
  stdio: 'inherit',
  // SD_ENABLE_ASIO: PortAudio shows ASIO devices only when it is set before sounddevice loads.
  env: { ...process.env, SD_ENABLE_ASIO: '1', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
});
// Ctrl+C reaches the child by itself (same console); it prints the final numbers and exits.
process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => child.kill());
child.on('error', (error) => {
  console.error(`Пробник не запустился: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
