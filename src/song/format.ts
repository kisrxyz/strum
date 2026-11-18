// Text for times, speed and pitch on the song screen.
import { L } from '../i18n';
import { decimal } from '../i18n/lang';

const pad = (n: number) => String(n).padStart(2, '0');

/** 83.4 → "1:23", 3725 → "1:02:05". */
export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function fmtSpeed(speed: number): string {
  return L().common.units.pct(Math.round(speed * 100));
}

/** Total shift in semitones: "0", "−1", "+1.95" (Russian: "+1,95"). */
export function fmtPitch(semitones: number, cents: number): string {
  const total = Math.round((semitones + cents / 100) * 100) / 100;
  if (total === 0) return '0';
  const text = decimal(String(Math.abs(total)));
  return (total > 0 ? '+' : '−') + text;
}

/** The download name from a Content-Disposition header (RFC 5987 name first). */
export function fileNameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      /* fall back to the plain name */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : null;
}
