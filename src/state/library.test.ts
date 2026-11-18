import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../song/types';
import { isBusy, refreshLibrary, startLibraryPolling, useLibrary } from './library';

const health = {
  ok: true,
  mlInstalled: true,
  models: [],
  defaultModel: 'bs_roformer_sw',
  maxSeconds: 720,
  device: 'cuda',
  gpuName: 'RTX',
};
const songs = [{ id: 'abcdef012345', title: 'Кукушка', stems: {} }];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshLibrary', () => {
  it('goes offline when the service does not answer, and back online when it does', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await refreshLibrary();
    expect(useLibrary.getState().service).toBe('offline');

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve(json(url.endsWith('/health') ? health : songs))),
    );
    await refreshLibrary();
    expect(useLibrary.getState().service).toBe('online');
    expect(useLibrary.getState().songs.map((s) => s.id)).toEqual(['abcdef012345']);
    expect(useLibrary.getState().health?.gpuName).toBe('RTX');
  });

  it('keeps checking now and then while idle, so a crashed service is noticed', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((url: string) => Promise.resolve(json(url.endsWith('/health') ? health : songs)));
    vi.stubGlobal('fetch', fetch);
    const stop = startLibraryPolling();
    await vi.advanceTimersByTimeAsync(100);
    const first = fetch.mock.calls.length;
    expect(first).toBe(2); // health + songs
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(useLibrary.getState().service).toBe('offline');
    stop();
    vi.useRealTimers();
  });

  it('treats the proxy answer «service down» (503) as offline too', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"detail":"Сервис песен не запущен."}', { status: 503 }))));
    await refreshLibrary();
    expect(useLibrary.getState().service).toBe('offline');
  });
});

describe('isBusy', () => {
  const song = (extra: object) => ({ id: 'abcdef012345', stems: {}, analysis: null, ...extra }) as unknown as Song;

  it('is busy while stems are made or the song is analysed', () => {
    expect(isBusy([song({})])).toBe(false);
    expect(isBusy([song({ stems: { htdemucs_6s: { status: 'queued' } } })])).toBe(true);
    expect(isBusy([song({ analysis: { status: 'running' } })])).toBe(true);
    expect(isBusy([song({ analysis: { status: 'ready' } })])).toBe(false);
  });
});
