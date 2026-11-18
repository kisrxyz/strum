// The installed app's first start on «Songs»: how much of song separation is downloaded, and the
// words model when asked for (service components.py). The author's copy never shows it.
import { HardDriveDownload } from 'lucide-react';
import type { Dict } from '../i18n';
import { messageText } from '../i18n/messages';
import { useLang } from '../i18n/useLang';
import { api } from '../song/api';
import type { ComponentPart, ComponentsStatus } from '../song/types';
import { refreshLibrary, useLibrary } from '../state/library';
import { useSettings } from '../state/settings';

export function sizeText(bytes: number, t: Dict, lang: string): string {
  const one = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return bytes >= 1e9 ? t.library.setup.gb(one.format(bytes / 1e9)) : t.library.setup.mb(String(Math.max(1, Math.round(bytes / 1e6))));
}

export interface SetupLine {
  text: string;
  /** 0…1 while it downloads. */
  fraction: number | null;
  error: string | null;
  action: 'download' | 'retry' | null;
  part: 'songs' | 'words';
  /** The small line under it (default: songs wait for the download). */
  hint?: string;
}

function progress(part: ComponentPart): number | null {
  return part.total > 0 ? Math.min(1, part.done / part.total) : null;
}

/** What the note says, or null when there is nothing to say. */
export function setupLine(status: ComponentsStatus | undefined, t: Dict, lang: string): SetupLine | null {
  if (!status?.canInstall) return null;
  const words = t.library.setup;
  const { songs } = status;
  if (songs.state !== 'ready' || songs.stage === 'restarting') {
    const base = { part: 'songs' as const, error: null, action: null, fraction: null };
    if (songs.state === 'failed') {
      return { ...base, text: words.failed, error: songs.error ? messageText(songs.error) : null, action: 'retry' };
    }
    if (songs.state === 'missing') {
      const text = songs.estimate ? words.missing(sizeText(songs.estimate, t, lang)) : words.missingNoSize;
      return { ...base, text, action: 'download', hint: words.what };
    }
    if (songs.stage === 'restarting') return { ...base, text: words.restarting };
    if (songs.stage === 'packages' && songs.total > 0) {
      return { ...base, text: words.downloading(sizeText(songs.done, t, lang), sizeText(songs.total, t, lang)), fraction: progress(songs) };
    }
    if (songs.stage === 'weights' && songs.total > 0) {
      return { ...base, text: words.models(Math.min(songs.done + 1, songs.total), songs.total), fraction: progress(songs) };
    }
    return { ...base, text: words.preparing };
  }
  const voice = status.words;
  if (voice.state === 'installing') {
    const total = sizeText(voice.total, t, lang);
    return { part: 'words', text: words.words(sizeText(voice.done, t, lang), total), fraction: progress(voice), error: null, action: null };
  }
  if (voice.state === 'failed') {
    return { part: 'words', text: words.wordsFailed, fraction: null, error: voice.error ? messageText(voice.error) : null, action: 'retry' };
  }
  return null;
}

export function SetupNote() {
  const status = useLibrary((s) => s.health?.components);
  const lang = useSettings((s) => s.language);
  const t = useLang();
  const line = setupLine(status, t, lang);
  if (!line) return null;
  const start = () => void api.installComponent(line.part).then(refreshLibrary, refreshLibrary);
  return (
    <div className="setup" role="status">
      <HardDriveDownload size={20} />
      <div className="setup__words">
        <span className={line.error ? 'setup__text note--cold' : 'setup__text'}>{line.text}</span>
        {line.error && <p className="note">{line.error}</p>}
        {line.part === 'songs' && !line.error && <p className="note">{line.hint ?? t.library.setup.wait}</p>}
        {line.fraction !== null && (
          <span className="bar setup__bar" aria-hidden="true">
            <span style={{ width: `${Math.round(line.fraction * 100)}%` }} />
          </span>
        )}
      </div>
      {line.action && (
        <button type="button" className="btn btn--lg is-on" onClick={start}>
          {line.action === 'retry' ? t.library.setup.retry : t.library.setup.download}
        </button>
      )}
    </div>
  );
}
