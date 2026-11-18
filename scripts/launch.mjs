// What the desktop shortcut «Strum» runs (made by `npm run shortcut`): `npm run dev` in a
// window of its own. If the app already runs (a second double-click), it only opens Chrome.
// Closing the window stops everything, like Ctrl+C.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_URL = 'http://localhost:5173/';

async function appRunning() {
  try {
    const res = await fetch(APP_URL, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function openChrome() {
  if (process.platform === 'win32') {
    // `start` finds chrome.exe through App Paths, even when it is not on PATH.
    spawn(`start "" chrome "${APP_URL}"`, { shell: true, stdio: 'ignore', windowsHide: true });
  } else if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Google Chrome', APP_URL], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('xdg-open', [APP_URL], { stdio: 'ignore', detached: true }).unref();
  }
}

/** Waits for Enter, so an error stays readable before the window closes. */
function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
    process.stdin.once('end', resolve);
  });
}

if (await appRunning()) {
  console.log('Strum уже запущен — открываю Chrome.');
  openChrome();
  setTimeout(() => process.exit(0), 1500);
} else {
  console.log('Strum запускается, Chrome откроется сам.');
  console.log('Это окно и есть Strum: закроешь его — всё выключится. Можно свернуть.\n');

  // The shortcut starts from Explorer, where PATH can miss Node: run npm with this very Node and put
  // its folder first on PATH for the scripts npm starts (`node scripts/...`).
  const nodeDir = dirname(process.execPath);
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [nodeDir, env[pathKey]].filter(Boolean).join(delimiter);
  const npmCli = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const child = existsSync(npmCli)
    ? spawn(process.execPath, [npmCli, 'run', 'dev'], { cwd: root, env, stdio: 'inherit' })
    : spawn('npm', ['run', 'dev'], { cwd: root, env, stdio: 'inherit', shell: true });

  // Ctrl+C reaches npm as well (same console): let it stop, then close without the error prompt.
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });
  child.on('error', async (err) => {
    console.error(`\nНе получилось запустить npm: ${err.message}`);
    console.error('Нажми Enter, чтобы закрыть окно.');
    await waitForEnter();
    process.exit(1);
  });
  child.on('exit', async (code) => {
    if (code !== 0 && !stopping) {
      console.error('\nStrum остановился с ошибкой — посмотри текст выше.');
      console.error('Нажми Enter, чтобы закрыть окно.');
      await waitForEnter();
    }
    process.exit(code ?? 0);
  });
}
