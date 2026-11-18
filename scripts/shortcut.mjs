// `npm run shortcut`: puts «Strum» on the desktop. A double-click runs scripts/launch.mjs
// (that is `npm run dev` in its own window, or just Chrome if the app already runs).
// Windows: a .lnk with the app's icon (drawn here: the favicon's amber circle). macOS: a .command file.
import { spawnSync } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'Strum';
// The shortcut's name before 2026-11-17: removed from the same desktop when the new one is made.
const OLD_NAME = 'Квартирник';
const launcher = join(root, 'scripts', 'launch.mjs');

/**
 * One RGBA PNG of the icon: an amber guitar pick on transparent (4×4 supersampling). The pick is the
 * convex hull of four circles on a 32-unit grid (two top corners, the tip, a wide one that bows
 * the top edge) — the same outline as the favicon in index.html and src/ui/Mark.tsx.
 */
const PICK_DISKS = [[8.5, 9, 6.5], [23.5, 9, 6.5], [16, 28.5, 2.5], [16, 14, 12]];
const PICK_DIRS = Array.from({ length: 180 }, (_, i) => [Math.cos((Math.PI * i) / 90), Math.sin((Math.PI * i) / 90)]);
const PICK_SUPPORT = PICK_DIRS.map(([ux, uy]) => Math.max(...PICK_DISKS.map(([x, y, r]) => x * ux + y * uy + r)));

function iconPng(size) {
  const px = Buffer.alloc(size * size * 4);
  const amber = [0xf2, 0xa2, 0x4a];
  const unit = 32 / size;
  /** Inside the hull: on the inner side of every support line. */
  const sd = (x, y) => (PICK_DIRS.every(([ux, uy], i) => x * unit * ux + y * unit * uy <= PICK_SUPPORT[i]) ? -1 : 1);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) if (sd(x + (sx + 0.5) / S, y + (sy + 0.5) / S) <= 0) cover++;
      }
      if (!cover) continue;
      const i = (y * size + x) * 4;
      for (let k2 = 0; k2 < 3; k2++) px[i + k2] = amber[k2];
      px[i + 3] = Math.round((255 * cover) / (S * S));
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An .ico holding PNG images (Windows Vista and later read these). */
function icoFile(sizes) {
  const pngs = sizes.map(iconPng);
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((size, i) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...pngs]);
}

function windows() {
  // A new path for the pick: Windows caches icons by path and would keep the old disc.
  const icon = join(root, 'scripts', 'strum.ico');
  writeFileSync(icon, icoFile([16, 24, 32, 48, 256]));
  // WScript.Shell finds the real desktop (it may live in OneDrive). Values go through the
  // environment, so paths with spaces or Cyrillic need no quoting in the command.
  const ps = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$sh = New-Object -ComObject WScript.Shell',
    "$path = Join-Path $sh.SpecialFolders('Desktop') ($env:KV_NAME + '.lnk')",
    '$lnk = $sh.CreateShortcut($path)',
    '$lnk.TargetPath = $env:KV_NODE',
    '$lnk.Arguments = $env:KV_ARGS',
    '$lnk.WorkingDirectory = $env:KV_ROOT',
    "$lnk.IconLocation = $env:KV_ICON + ',0'",
    '$lnk.Description = $env:KV_DESC',
    '$lnk.Save()',
    "$old = Join-Path $sh.SpecialFolders('Desktop') ($env:KV_OLD + '.lnk')",
    'if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old }',
    'Write-Output $path',
  ].join('; ');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KV_NAME: NAME,
      KV_OLD: OLD_NAME,
      KV_NODE: process.execPath,
      KV_ARGS: `"${launcher}"`,
      KV_ROOT: root,
      KV_ICON: icon,
      KV_DESC: 'Запустить Strum и открыть Chrome',
    },
  });
  if (res.status !== 0) {
    console.error('Не получилось сделать ярлык:', (res.stderr || res.error?.message || '').trim());
    process.exit(1);
  }
  return res.stdout.trim();
}

function mac() {
  const path = join(homedir(), 'Desktop', `${NAME}.command`);
  rmSync(join(homedir(), 'Desktop', `${OLD_NAME}.command`), { force: true });
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${launcher}"\n`);
  chmodSync(path, 0o755);
  return path;
}

if (process.platform !== 'win32' && process.platform !== 'darwin') {
  console.error('Ярлык умею делать только на Windows и macOS. Запускай `npm run dev`.');
  process.exit(1);
}
const made = process.platform === 'win32' ? windows() : mac();
console.log(`Готово: ${made}`);
console.log('Двойной клик — Strum запустится и откроет Chrome. Закрыть окно Strum — выключить.');
