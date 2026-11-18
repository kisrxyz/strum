import { useState } from 'react';
import type { Dict } from '../i18n';
import { messageText } from '../i18n/messages';
import { useLang } from '../i18n/useLang';
import { textActions } from '../song/textActions';
import { isTabSong, type Song } from '../song/types';
import { useSong } from '../state/song';

/** What was heard in the vocals, in a few words. */
function transcriptText(song: Song, t: Dict): string {
  const e = t.songUi.lyricsEditor;
  const info = song.transcript;
  if (isTabSong(song)) return t.songUi.lyrics.tabNoVoice;
  if (!song.activeModel) return e.needsVocals;
  if (!info) return e.notHeard;
  if (info.status === 'queued') return e.queued;
  if (info.status === 'running') return e.running(info.progress ? Math.round(info.progress * 100) : null);
  if (info.status === 'error') return e.failed(messageText(info.error) || t.songUi.unknownError);
  return e.heard(info.language ?? null);
}

/**
 * The lyrics as text, editable, in place of the fretboard and the mixer (like the chord editor).
 * Its buttons: the draft from the vocals, the search online, saving .lrc / .cho, printing, removing.
 */
export function LyricsEditor({ song }: { song: Song }) {
  const t = useLang();
  const e = t.songUi.lyricsEditor;
  const [draft, setDraft] = useState(song.lyrics?.text ?? '');
  const original = song.lyrics?.text ?? '';
  const close = () => useSong.getState().patch({ editingLyrics: false });

  const save = () => {
    if (draft !== original) {
      const lines = (text: string) => text.split('\n').length;
      const keepAnchors = song.lyrics && lines(draft) === lines(original);
      useSong.getState().updateLyrics(
        draft.trim()
          ? { source: song.lyrics?.source ?? 'paste', text: draft, anchors: keepAnchors ? song.lyrics!.anchors : [], shift: song.lyrics?.shift ?? null }
          : null,
      );
      if (draft.trim()) useSong.getState().updatePlayer({ view: 'lyrics' });
    }
    close();
  };

  return (
    <section className="lyrics-editor" aria-label={e.label}>
      <textarea
        className="lyrics-editor__text"
        value={draft}
        spellCheck={false}
        placeholder={e.placeholder}
        onChange={(ev) => setDraft(ev.target.value)}
      />
      <div className="lyrics-editor__side">
        <div className="lyrics-editor__buttons">
          <button type="button" className="primary" onClick={save}>
            {t.common.done}
          </button>
          <button type="button" className="chip" onClick={close}>
            {t.common.cancel}
          </button>
          <button type="button" className="chip" onClick={() => void textActions.useDraft().then(close)}>
            {e.draft}
          </button>
          <button type="button" className="chip" onClick={() => void textActions.findOnline().then(close)}>
            {e.findOnline}
          </button>
          {song.lyrics && (
            <>
              <button type="button" className="chip" onClick={() => textActions.saveLrc()}>
                {e.saveLrc}
              </button>
              <button type="button" className="chip" onClick={() => textActions.saveChordPro()}>
                {e.saveCho}
              </button>
              <button type="button" className="chip" onClick={() => window.print()}>
                {t.songUi.print}
              </button>
              <button type="button" className="chip" onClick={() => textActions.removeLyrics()}>
                {e.remove}
              </button>
            </>
          )}
        </div>
        <p className="note">
          {song.lyrics ? `${e.source[song.lyrics.source]} ` : ''}
          {transcriptText(song, t).replace(/([^.!?…])$/, '$1.')} {e.privacy}
        </p>
      </div>
    </section>
  );
}
