// Recognising dropped files: amp models (.nam), cabinet impulse responses (short .wav) and songs.

export type AssetKind = 'model' | 'ir';
export type DropKind = AssetKind | 'song' | 'tab' | 'lyrics';

export const SONG_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'];
/** Guitar Pro 3–8 and MusicXML: a song of its own (played by the app), or the open recording's tab. */
export const TAB_EXTENSIONS = ['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'musicxml', 'mxl', 'xml'];
/** Plain text, ChordPro, .lrc: the open song's lyrics (a .txt may hold a text tab). */
export const LYRICS_EXTENSIONS = ['txt', 'cho', 'crd', 'chopro', 'chordpro', 'pro', 'lrc'];
/** A .wav longer than this is a song, a shorter one a cabinet (cabinets last well under a second). */
export const SONG_MIN_WAV_SECONDS = 20;

/** «Кино — Группа крови.GP4» → «gp4». */
export const fileExtension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};
const extension = fileExtension;

export function classifyAssetFile(name: string): AssetKind | null {
  const ext = extension(name);
  if (ext === 'nam') return 'model';
  if (ext === 'wav') return 'ir';
  return null;
}

/** `wav` is the header info of a .wav file (null if unreadable or not a .wav). */
export function classifyDrop(name: string, wav: { durationSeconds: number } | null): DropKind | null {
  const ext = extension(name);
  if (ext === 'nam') return 'model';
  if (ext === 'wav') return wav && wav.durationSeconds > SONG_MIN_WAV_SECONDS ? 'song' : 'ir';
  if (TAB_EXTENSIONS.includes(ext)) return 'tab';
  if (LYRICS_EXTENSIONS.includes(ext)) return 'lyrics';
  return SONG_EXTENSIONS.includes(ext) ? 'song' : null;
}

/** RIFF/WAVE check on raw bytes (decoding the header as text breaks on the binary size field). */
export function isWavHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}
