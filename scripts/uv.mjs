// Finds uv (the Python tool that runs the song service) and, when run as a script, forwards the
// arguments to it: `node scripts/uv.mjs run --no-sync --directory service pytest`.
//
// uv is looked up on PATH first, then in the places its installers use. On Windows the user PATH
// is sometimes cut at 1024 characters (an old `setx` limit), which hides a winget install.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exe = process.platform === 'win32' ? 'uv.exe' : 'uv';

function wingetCandidates() {
  const base = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet');
  if (!base) return [];
  const found = [join(base, 'Links', exe)];
  try {
    for (const name of readdirSync(join(base, 'Packages'))) {
      if (name.startsWith('astral-sh.uv')) found.push(join(base, 'Packages', name, exe));
    }
  } catch {
    /* no winget packages folder */
  }
  return found;
}

/** Absolute path to uv, or null when it is not installed. */
export function findUv() {
  if (process.env.UV && existsSync(process.env.UV)) return process.env.UV;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  const home = homedir();
  const candidates = [
    join(home, '.local', 'bin', exe),
    join(home, '.cargo', 'bin', exe),
    ...(process.platform === 'win32' ? wingetCandidates() : ['/opt/homebrew/bin/uv', '/usr/local/bin/uv']),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

export const UV_MISSING_TEXT = [
  'Не нашёл uv — программу, которая запускает сервис песен.',
  'Поставь её одной командой:',
  process.platform === 'win32'
    ? '  winget install --id=astral-sh.uv -e'
    : '  curl -LsSf https://astral.sh/uv/install.sh | sh',
  'Потом закрой и снова открой терминал и выполни: npm run setup',
  'Комбик работает и без сервиса, а песни без него не добавляются.',
].join('\n');

/** True when `importMetaUrl` belongs to the script Node was started with. */
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(fileURLToPath(importMetaUrl)) === norm(process.argv[1]);
}

if (isMain(import.meta.url)) {
  const uv = findUv();
  if (!uv) {
    console.error(UV_MISSING_TEXT);
    process.exit(1);
  }
  const result = spawnSync(uv, process.argv.slice(2), {
    stdio: 'inherit',
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  process.exit(result.status ?? 1);
}
