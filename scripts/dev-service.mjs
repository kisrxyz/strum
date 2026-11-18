// Runs the song service next to Vite (`npm run dev` starts both through concurrently).
// Always exits with code 0: if the service cannot start, the amp still works and the song screen
// explains what to do, so concurrently must not stop Vite because of it.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUv, UV_MISSING_TEXT } from './uv.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uv = findUv();
if (!uv) {
  console.warn(UV_MISSING_TEXT);
  process.exit(0);
}

// --no-sync: the running app never installs or downloads anything (that is `npm run setup`).
const child = spawn(uv, ['run', '--no-sync', '--project', 'service', 'python', '-m', 'kv_service'], {
  cwd: root,
  stdio: 'inherit',
  // Unbuffered, so the service's messages show up in the terminal at once.
  env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
});
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('error', (error) => {
  console.warn(`Сервис песен не запустился: ${error.message}`);
  process.exit(0);
});
child.on('exit', (code) => {
  if (code) console.warn('Сервис песен остановился. Если это не ты нажал Ctrl+C — запусти npm run setup, потом npm run dev.');
  process.exit(0);
});
