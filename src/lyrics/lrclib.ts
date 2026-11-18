// LRCLIB (https://lrclib.net): free lyrics, often with line times, no key. Only on the user's
// button: what leaves the laptop is the artist, the title and the song's length.

export interface LrclibHit {
  id: number;
  trackName: string;
  artistName: string;
  duration: number;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

/** How far the length may differ for a hit to be this recording, seconds. */
const MAX_DURATION_DIFF = 4;

export function lrclibSearchUrl(artist: string, title: string): string {
  const params = new URLSearchParams({ track_name: title.trim() });
  if (artist.trim()) params.set('artist_name', artist.trim());
  return `https://lrclib.net/api/search?${params}`;
}

/** The best hit for a recording of `duration` s: timed lyrics first, then the closest length. */
export function pickLrclib(hits: LrclibHit[], duration: number): LrclibHit | null {
  const near = hits.filter((h) => (h.syncedLyrics || h.plainLyrics) && Math.abs(h.duration - duration) <= MAX_DURATION_DIFF);
  near.sort((a, b) => Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics) || Math.abs(a.duration - duration) - Math.abs(b.duration - duration));
  return near[0] ?? null;
}
