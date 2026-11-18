import { useRef } from 'react';
import { useLang } from '../i18n/useLang';
import { importFiles } from '../song/importSong';
import { useLibrary } from '../state/library';

/** «Добавить песню»: a file picker for when dragging into the window is awkward. */
export function AddSongButton() {
  const input = useRef<HTMLInputElement>(null);
  const importing = useLibrary((s) => s.importing);
  const t = useLang();
  const phase = importing && t.library.importPhase[importing.phase];
  return (
    <div className="addsong">
      <button
        type="button"
        className="btn"
        title={t.library.addSongTip}
        disabled={!!importing}
        onClick={() => input.current?.click()}
      >
        {t.library.addSong}
      </button>
      {importing && phase && (
        <span className="addsong__progress" role="status">
          {t.library.importing(importing.name, phase)}
          {importing.phase === 'upload' ? (
            <span className="num"> {t.common.units.pct(Math.round(importing.progress * 100))}</span>
          ) : (
            '…'
          )}
        </span>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept="audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.mxl"
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void importFiles(files);
        }}
      />
    </div>
  );
}
