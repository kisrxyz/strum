import { Plus } from 'lucide-react';
import { useRef } from 'react';
import { useLang } from '../i18n/useLang';
import { importFiles } from '../song/importSong';
import { useLibrary } from '../state/library';

/** Add a song: a file picker for when dragging into the window is awkward. Its progress shows in the status strip. */
export function AddSongButton({ primary = false }: { primary?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const importing = useLibrary((s) => s.importing);
  const t = useLang();
  return (
    <>
      <button
        type="button"
        className={`btn${primary ? ' btn--primary' : ''} btn--lg`}
        title={t.library.addSongTip}
        disabled={!!importing}
        onClick={() => input.current?.click()}
      >
        <Plus size={16} />
        {t.library.addSong}
      </button>
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
    </>
  );
}
