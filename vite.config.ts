import { alphaTab } from '@coderline/alphatab-vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * While a local service is down (the song service, the fast guitar engine) the app keeps trying to
 * reach it: the amp works without them. Answer those requests with a short 503 instead of Vite's
 * default: a full stack trace in the terminal for every poll or reconnect. Vite adds its own error
 * listener right after `configure`, so that one is skipped.
 *
 * The proxy's `error` event carries a ServerResponse for a plain request and the client's Socket
 * for a WebSocket upgrade; both are answered without throwing.
 */
const quietWhenDown =
  (detail: string): NonNullable<ProxyOptions['configure']> =>
  (proxy) => {
    proxy.on('error', (_error, _req, res) => {
      if ('writeHead' in res) {
        if (res.headersSent || res.writableEnded) return;
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ detail }));
        return;
      }
      // A WebSocket upgrade: a plain 503 if the handshake answer was not started yet, else just close.
      if (res.destroyed) return;
      if (res.writable && res.bytesWritten === 0) {
        const body = JSON.stringify({ detail });
        res.end(
          `HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json; charset=utf-8\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      } else {
        res.destroy();
      }
    });
    type Listen = (event: string, listener: (...args: unknown[]) => void) => unknown;
    const on = proxy.on.bind(proxy) as unknown as Listen;
    const skipErrorListeners: Listen = (event, listener) => (event === 'error' ? proxy : on(event, listener));
    proxy.on = skipErrorListeners as unknown as typeof proxy.on;
  };

// The app is built for Chrome (output device choice, latency), so `npm run dev` opens Chrome even
// when another browser is the system default. Setting BROWSER yourself (e.g. `none`) still wins.
const CHROME: Partial<Record<string, string>> = { darwin: 'google chrome', win32: 'chrome' };
process.env.BROWSER ??= CHROME[process.platform] ?? 'google-chrome';

// One version for the page (About) and the installer (shell/tauri.conf.json reads package.json too).
const version: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  define: { __STRUM_VERSION__: JSON.stringify(version) },
  // alphaTab (tabs, stage 3): its fonts and rendering worker are served by the app itself, never
  // from the internet. Its audio worklet is not needed: our player is the tab's clock.
  plugins: [react(), alphaTab({ audioWorklets: false })],
  server: {
    port: 5173,
    // A fixed address keeps the browser's microphone permission between launches.
    strictPort: true,
    open: true,
    proxy: {
      // The song service (service/, started next to Vite by `npm run dev`).
      // KV_PORT moves both the service and this proxy (a second copy for checks, next to `npm run dev`).
      '/api': {
        target: `http://127.0.0.1:${process.env.KV_PORT ?? 5174}`,
        configure: quietWhenDown('Сервис песен не запущен.'),
      },
      // The fast guitar engine (service/src/kv_guitar, started next to Vite by `npm run dev`):
      // a WebSocket. KV_GUITAR_PORT moves both the engine and this proxy. While it is down the app
      // plays the guitar through the browser.
      '/guitar': {
        target: `ws://127.0.0.1:${process.env.KV_GUITAR_PORT ?? 5175}`,
        ws: true,
        configure: quietWhenDown('Быстрый звук не запущен.'),
      },
    },
  },
  preview: { port: 5173, strictPort: true },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
