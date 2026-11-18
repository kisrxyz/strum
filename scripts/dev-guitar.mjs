// Runs the fast guitar engine (service/src/kv_guitar: ASIO -> NAM -> cabinet in Python) next to Vite.
// `npm run dev` starts it through concurrently; Vite proxies /guitar (WebSocket) to it.
// Always exits with code 0: when the engine cannot start or stops, the app plays the guitar through
// the browser instead, so concurrently must not stop Vite because of it.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUv } from './uv.mjs';

const CRASH_TEXT = 'Быстрый звук остановился — гитара пойдёт через браузер. Перезапусти npm run dev.';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uv = findUv();
if (!uv) {
  // dev-service.mjs prints the full "install uv" instructions; this one only says what it means here.
  console.warn('Не нашёл uv — быстрый звук не запустится, гитара пойдёт через браузер.');
  process.exit(0);
}

// --no-sync: the running app never installs or downloads anything (that is `npm run setup`).
const child = spawn(uv, ['run', '--no-sync', '--project', 'service', 'python', '-m', 'kv_guitar'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    // PortAudio shows ASIO devices only when this is set before sounddevice loads.
    SD_ENABLE_ASIO: '1',
    // Unbuffered, so the engine's messages show up in the terminal at once.
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
  },
});

// Set when this script is asked to stop (Ctrl+C, concurrently shutting down): then the child's exit
// is expected and the crash text would only confuse.
let stopping = false;
const stop = () => {
  stopping = true;
  child.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('error', (error) => {
  console.warn(`Быстрый звук не запустился: ${error.message}\n${CRASH_TEXT}`);
  process.exit(0);
});
child.on('exit', (code, signal) => {
  if (!stopping && (code || signal)) console.warn(CRASH_TEXT);
  process.exit(0);
});
