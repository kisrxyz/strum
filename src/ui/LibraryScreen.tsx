import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  GraduationCap,
  Heart,
  ListMusic,
  ListOrdered,
  Mic,
  Minus,
  Pause,
  Play,
  Radio,
  Search,
  Shuffle,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { L, withKey, type Dict } from '../i18n';
import { messageText } from '../i18n/messages';
import { useLang } from '../i18n/useLang';
import { keyName, keySpelling } from '../music/keys';
import { TUNINGS } from '../music/tunings';
import { deleteSongTwice, readyModels, songActions } from '../song/actions';
import { api } from '../song/api';
import { fmtTime } from '../song/format';
import { funActions } from '../song/funActions';
import { LIST_ORDER, filterSongs, searchKey, type LibraryList } from '../song/setlist';
import { isTabSong, MODELS, MODEL_NAMES, type ModelId, type Song, type StemsInfo, type Take, type TuningId } from '../song/types';
import { NUDGE_MS, takeActions, takeWhen } from '../record/takeActions';
import { refreshLibrary, useLibrary } from '../state/library';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { refreshTakes, useTakes } from '../state/takes';
import { AddSongButton } from './AddSongButton';
import { SetupNote } from './SetupNote';

type Editable = Pick<Song, 'title' | 'artist' | 'notes'>;

async function saveField(id: string, patch: Partial<Editable>): Promise<void> {
  if (useSong.getState().song?.id === id) {
    useSong.getState().updateSong(patch);
    return;
  }
  try {
    await api.patchSong(id, patch);
    await refreshLibrary();
  } catch (error) {
    useRuntime.getState().showToast(error instanceof Error ? error.message : L().library.saveFailed, 'warn');
  }
}

const percent = (progress: number | undefined) => Math.round((progress ?? 0) * 100);

function stemLine(info: StemsInfo | undefined, t: Dict): string {
  if (!info) return t.library.notSplit;
  switch (info.status) {
    case 'queued':
      return t.library.queued;
    case 'running':
      return t.library.separating(percent(info.progress));
    case 'error':
      return t.library.failed(messageText(info.error));
    case 'ready':
      return t.library.doneIn(Math.round(info.seconds ?? 0));
  }
}

/** «Am», when the song has been analysed. */
function songKey(song: Song): string {
  const info = song.analysis;
  return info?.status === 'ready' && info.key ? keyName(info.key, keySpelling(info.key)) : '';
}

/** 118, when the song has been analysed and has beats. */
function songTempo(song: Song): number | null {
  const info = song.analysis;
  return info?.status === 'ready' && info.tempo ? Math.round(info.tempo) : null;
}

function analysisLine(song: Song, t: Dict): string {
  const info = song.analysis;
  if (!info) return t.library.chordsNotYet;
  switch (info.status) {
    case 'queued':
      return t.library.queued;
    case 'running':
      return t.library.findingChords(percent(info.progress));
    case 'error':
      return t.library.failed(messageText(info.error));
    case 'ready': {
      const facts = [songKey(song), songTempo(song) ? `${songTempo(song)} BPM` : ''].filter(Boolean).join(', ');
      return t.library.chordsReady(!!info.source && info.source !== 'mix', facts);
    }
  }
}

/** The separation's state for a row of the list: only while it runs, waits, failed or never ran. */
function rowStatus(song: Song, t: Dict): { text: string; error: boolean; progress: number | null } | null {
  if (isTabSong(song)) return { text: t.library.tabSong, error: false, progress: null };
  const entries = Object.entries(song.stems) as [ModelId, StemsInfo][];
  const running = entries.find(([, info]) => info.status === 'running');
  if (running) return { text: t.library.separating(percent(running[1].progress)), error: false, progress: running[1].progress ?? 0 };
  if (entries.some(([, info]) => info.status === 'queued')) return { text: t.library.waitingToSeparate, error: false, progress: null };
  const failed = entries.find(([, info]) => info.status === 'error');
  if (failed && !readyModels(song.stems).length) return { text: messageText(failed[1].error) || t.library.separationFailed, error: true, progress: null };
  if (!entries.length) return { text: t.library.notSeparated, error: false, progress: null };
  return null;
}

const tuningShort = (id: TuningId, t: Dict): string => t.library.tuningShort[id] ?? t.library.tuningShort.standard;

async function openSong(id: string): Promise<void> {
  await useSong.getState().openSong(id);
  useRuntime.getState().patch({ view: 'song' });
}

/** Enter (in the search too) and Play: open the highlighted song; in the set list play the set from it. */
function playSelected(): void {
  const id = useLibrary.getState().selectedId;
  if (!id) return;
  if (useRuntime.getState().libraryList === 'set') return funActions.playSet();
  void openSong(id);
}

/** Title and artist look like a heading until hovered or focused: then they are fields (rename). */
function NameField({ song, field, label }: { song: Song; field: 'title' | 'artist'; label: string }) {
  const t = useLang();
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
    else if (e.key === 'Escape') {
      e.currentTarget.value = song[field];
      e.currentTarget.blur();
    }
  };
  return (
    <input
      // A new key per song: the field starts again from the newly selected song's value.
      key={`${song.id}-${field}`}
      className={`info__name info__name--${field}`}
      type="text"
      maxLength={200}
      defaultValue={song[field]}
      placeholder={field === 'artist' ? t.library.artist : t.library.songTitle}
      aria-label={label}
      title={t.library.rename(label)}
      spellCheck={false}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        const value = e.currentTarget.value.trim();
        if (value !== song[field]) void saveField(song.id, { [field]: value });
      }}
    />
  );
}

/** The properties of the highlighted song, on the right: its names, facts, what is ready, lists, notes. */
function SongInfo({ song }: { song: Song }) {
  const list = useRuntime((s) => s.libraryList);
  const [more, setMore] = useState(false);
  const t = useLang();
  const key = songKey(song);
  const tempo = songTempo(song);
  const tuning = TUNINGS[song.player.tuning]?.name ?? '';
  const stemsReady = readyModels(song.stems).length > 0;
  const tabSong = isTabSong(song);
  const lyrics = { name: t.library.chipLyrics, on: !!song.lyrics?.text.trim(), hint: song.lyrics ? t.library.hasLyrics : t.library.noLyrics };
  const ready: { name: string; on: boolean; hint: string }[] = tabSong
    ? [{ name: t.library.chipFromTab, on: true, hint: t.library.tabPlays(song.tab?.name ?? '') }, lyrics]
    : [
        { name: t.library.chipStems, on: stemsReady, hint: stemsReady ? t.library.stemsReady : t.library.noStems },
        { name: t.library.chipChords, on: song.analysis?.status === 'ready', hint: `${t.library.barsAndChords}: ${analysisLine(song, t)}` },
        lyrics,
        { name: t.library.chipTab, on: !!song.tab, hint: song.tab ? t.library.tabNamed(song.tab.name) : t.library.noTab },
      ];

  return (
    <aside className="info" aria-label={t.library.card}>
      <div className="info__names">
        <NameField song={song} field="title" label={t.library.songTitle} />
        <NameField song={song} field="artist" label={t.library.artist} />
      </div>

      <button type="button" className="btn btn--primary btn--lg info__go" title={list === 'set' ? t.library.playSetTip : undefined} onClick={() => playSelected()}>
        <Play size={16} fill="currentColor" strokeWidth={0} />
        {list === 'set' ? t.library.playSet : t.library.play}
        <kbd>Enter</kbd>
      </button>

      <dl className="info__facts">
        <div>
          <dt>{t.library.length}</dt>
          <dd className="num">{fmtTime(song.duration)}</dd>
        </div>
        <div>
          <dt>{t.library.key}</dt>
          <dd className="num">{key || '–'}</dd>
        </div>
        <div>
          <dt>{t.library.tempo}</dt>
          <dd className="num">{tempo ?? '–'}</dd>
        </div>
        <div>
          <dt>{t.library.tuning}</dt>
          <dd title={tuning}>
            {tuningShort(song.player.tuning, t)}
            {song.player.capo > 0 && t.library.capo(song.player.capo)}
          </dd>
        </div>
      </dl>

      <ul className="info__ready" aria-label={t.library.ready}>
        {ready.map((r) => (
          <li key={r.name} data-on={r.on} title={r.hint}>
            {r.on ? <Check size={14} /> : <Minus size={14} />}
            {r.name}
          </li>
        ))}
      </ul>

      <SongLists song={song} />

      <textarea
        key={`${song.id}-notes`}
        className="input-text info__notes"
        rows={3}
        maxLength={10_000}
        defaultValue={song.notes}
        placeholder={t.library.notes}
        aria-label={t.library.notes}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
        onBlur={(e) => {
          const value = e.currentTarget.value.trim();
          if (value !== song.notes) void saveField(song.id, { notes: value });
        }}
      />

      <div className="info__foot">
        {!tabSong && (
          <button type="button" className="link info__more" aria-expanded={more} onClick={() => setMore(!more)}>
            {more ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {t.library.processing}
          </button>
        )}
        <button type="button" className="link link--danger" title={withKey(t.library.deleteSongTip, 'Delete')} onClick={() => void deleteSongTwice(song.id)}>
          {t.common.delete}
        </button>
      </div>

      {more && !tabSong && <Processing song={song} />}
    </aside>
  );
}

/** Stems and analysis: each model's stems, the bars and chords, how long they took. */
function Processing({ song }: { song: Song }) {
  const t = useLang();
  const analysisBusy = song.analysis?.status === 'queued' || song.analysis?.status === 'running';
  return (
    <div className="info__jobs">
      {MODELS.map((model: ModelId) => {
        const info = song.stems[model];
        const busy = info?.status === 'queued' || info?.status === 'running';
        return (
          <div key={model} className="job">
            <span className="job__name">
              {MODEL_NAMES[model]}
              {song.activeModel === model && <span className="job__playing">{t.library.playing}</span>}
            </span>
            <span className="job__state">{stemLine(info, t)}</span>
            <span className="job__action">
              {!busy && info?.status !== 'ready' && (
                <button type="button" className="link" onClick={() => void songActions.separate(song.id, model)}>
                  {info?.status === 'error' ? t.common.retry : t.library.separateWith(MODEL_NAMES[model])}
                </button>
              )}
              {(busy || info?.status === 'ready') && (
                <button type="button" className="link" onClick={() => void songActions.dropStems(song.id, model)}>
                  {busy ? t.library.stop : t.library.deleteStems}
                </button>
              )}
            </span>
            {info?.note && <span className="job__note">{messageText(info.note)}</span>}
          </div>
        );
      })}
      <div className="job">
        <span className="job__name">{t.library.barsAndChords}</span>
        <span className="job__state">{analysisLine(song, t)}</span>
        <span className="job__action">
          {!analysisBusy && (
            <button type="button" className="link" onClick={() => void songActions.analyze(song.id)}>
              {t.library.findAgain}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

/** The song's lists: favorites, learning, the set list (keys F, W, S on this screen), and its place in the set. */
function SongLists({ song }: { song: Song }) {
  const setlist = useSettings((s) => s.setlist);
  const list = useRuntime((s) => s.libraryList);
  const t = useLang();
  const lists = song.lists ?? [];
  const place = setlist.indexOf(song.id);
  const toggle = (on: boolean, Icon: LucideIcon, text: string, key: string, onClick: () => void) => (
    <button type="button" className="btn" aria-pressed={on} title={withKey(text, key)} onClick={onClick}>
      <Icon size={14} fill={on && Icon === Heart ? 'currentColor' : 'none'} />
      {text}
    </button>
  );
  return (
    <div className="info__lists" role="group" aria-label={t.library.listsOfSong}>
      {toggle(lists.includes('favorite'), Heart, lists.includes('favorite') ? t.library.inFavorites : t.library.toFavorites, 'F', () =>
        funActions.toggleSongList('favorite'),
      )}
      {toggle(lists.includes('learn'), GraduationCap, t.library.learning, 'W', () => funActions.toggleSongList('learn'))}
      {toggle(place >= 0, ListOrdered, place >= 0 ? t.library.inSet(place + 1) : t.library.toSet, 'S', () => funActions.toggleSet())}
      {list === 'set' && place >= 0 && (
        <span className="info__order">
          <button
            type="button"
            className="iconbtn"
            title={withKey(t.library.earlierInSet, 'Shift+↑')}
            aria-label={t.library.earlierInSet}
            disabled={place === 0}
            onClick={() => funActions.moveInSet(-1)}
          >
            <ArrowUp size={16} />
          </button>
          <button
            type="button"
            className="iconbtn"
            title={withKey(t.library.laterInSet, 'Shift+↓')}
            aria-label={t.library.laterInSet}
            disabled={place === setlist.length - 1}
            onClick={() => funActions.moveInSet(1)}
          >
            <ArrowDown size={16} />
          </button>
        </span>
      )}
    </div>
  );
}

/** The strip over the table: the search (/), a random song (Shift+L), the radio (R) and Add song. */
function LibraryBar() {
  const list = useRuntime((s) => s.libraryList);
  const search = useRuntime((s) => s.search);
  const setlist = useSettings((s) => s.setlist);
  const t = useLang();
  const move = (dir: 1 | -1) => {
    const visible = filterSongs(useLibrary.getState().songs, list, search, setlist);
    if (!visible.length) return;
    const index = visible.findIndex((s) => s.id === useLibrary.getState().selectedId);
    useLibrary.getState().patch({ selectedId: visible[Math.min(visible.length - 1, Math.max(0, index + dir))].id });
  };
  return (
    <header className="lib__bar">
      <label className="lib__search" title={withKey(t.library.searchLabel, '/')}>
        <Search size={16} />
        <input
          className="library__search"
          type="search"
          value={search}
          placeholder={t.library.search}
          aria-label={t.library.searchLabel}
          onChange={(e) => funActions.setSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
              if (e.key === 'Enter') playSelected();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              move(e.key === 'ArrowDown' ? 1 : -1);
            }
          }}
        />
      </label>
      <span className="lib__bargap" />
      {list !== 'takes' && (
        <>
          <button type="button" className="btn btn--ghost btn--lg" title={withKey(t.library.randomTip, 'Shift+L')} onClick={() => funActions.randomSong()}>
            <Shuffle size={16} />
            {t.library.random}
          </button>
          <button type="button" className="btn btn--ghost btn--lg" title={withKey(t.library.radioTip, 'R')} onClick={() => funActions.radio()}>
            <Radio size={16} />
            {t.library.radio}
          </button>
        </>
      )}
      <AddSongButton primary />
    </header>
  );
}

/** The takes whose title or artist has every word of the search. */
function filterTakes(takes: readonly Take[], query: string): Take[] {
  const words = searchKey(query).split(' ').filter(Boolean);
  if (!words.length) return [...takes];
  return takes.filter((t) => {
    const hay = searchKey(`${t.title} ${t.artist}`);
    return words.every((w) => hay.includes(w));
  });
}

/** «+10 ms», «−20 ms», «0 ms». */
function offsetText(ms: number, t: Dict): string {
  return `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${Math.abs(ms)} ${t.common.units.ms}`;
}

/** One take, on the right: listen (Enter), move the guitar against the song, download, delete. */
function TakeInfo({ take }: { take: Take }) {
  const playing = useTakes((s) => s.playingTakeId === take.id);
  const version = useTakes((s) => s.versions[take.id] ?? 0);
  const audio = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const t = useLang();
  // A new mp3 (after «Guitar earlier / later») goes on from the same place.
  const resumeAt = useRef(0);

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    if (playing) void el.play().catch(() => takeActions.stopPlaying());
    else el.pause();
  }, [playing, version]);

  useEffect(() => () => takeActions.stopPlaying(), [take.id]);

  const seek = (seconds: number) => {
    const el = audio.current;
    if (el) el.currentTime = seconds;
    setTime(seconds);
  };
  const length = Math.max(0.1, take.duration);

  return (
    <aside className="info" aria-label={t.library.take}>
      <div className="info__names">
        <h2 className="info__title">{take.title}</h2>
        {take.artist && <p className="info__artist">{take.artist}</p>}
      </div>

      <button type="button" className="btn btn--primary btn--lg info__go" onClick={() => takeActions.togglePlay(take.id)}>
        {playing ? <Pause size={16} fill="currentColor" strokeWidth={0} /> : <Play size={16} fill="currentColor" strokeWidth={0} />}
        {playing ? t.library.stop : t.library.listen}
        <kbd>Enter</kbd>
      </button>

      <label className="info__seek">
        <input
          type="range"
          min={0}
          max={length}
          step={0.1}
          value={Math.min(time, take.duration)}
          aria-label={t.library.positionLabel}
          style={{ '--pct': `${(Math.min(time, take.duration) / length) * 100}%`, '--fill': 'var(--accent)' } as CSSProperties}
          onChange={(e) => seek(Number(e.currentTarget.value))}
        />
        <span className="num">
          {fmtTime(time)} / {fmtTime(take.duration)}
        </span>
      </label>

      <dl className="info__facts info__facts--two">
        <div>
          <dt>{t.library.when}</dt>
          <dd>{takeWhen(take.createdAt)}</dd>
        </div>
        <div>
          <dt>{t.library.whatPlays}</dt>
          <dd>{take.hasBand ? t.library.guitarAndSong : t.library.guitarOnly}</dd>
        </div>
      </dl>

      {take.hasBand && (
        <div className="info__nudge">
          <span className="caption">{t.library.nudgeAsk}</span>
          <div className="info__nudgerow" role="group" aria-label={t.library.nudgeLabel}>
            <button type="button" className="btn" onClick={() => void takeActions.nudge(take.id, -NUDGE_MS)}>
              {t.library.guitarEarlier}
            </button>
            <span className="readout" title={t.library.offsetTip}>
              {offsetText(take.guitarOffsetMs, t)}
            </span>
            <button type="button" className="btn" onClick={() => void takeActions.nudge(take.id, NUDGE_MS)}>
              {t.library.guitarLater}
            </button>
          </div>
        </div>
      )}

      <div className="info__foot">
        <button type="button" className="link info__more" title={t.library.downloadTip} onClick={() => takeActions.download(take.id)}>
          <Download size={14} />
          {t.library.download}
        </button>
        <button type="button" className="link link--danger" title={withKey(t.library.deleteTakeTip, 'Delete')} onClick={() => void takeActions.deleteTwice(take.id)}>
          {t.common.delete}
        </button>
      </div>

      <audio
        ref={audio}
        src={api.takeUrl(take.id, version)}
        preload="metadata"
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          if (resumeAt.current) e.currentTarget.currentTime = resumeAt.current;
          resumeAt.current = 0;
        }}
        onEmptied={() => {
          resumeAt.current = time;
        }}
        onEnded={() => {
          takeActions.stopPlaying();
          seek(0);
        }}
      />
    </aside>
  );
}

/** The takes as a table, newest first. */
function TakesBody() {
  const allTakes = useTakes((s) => s.takes);
  const search = useRuntime((s) => s.search);
  const selectedId = useTakes((s) => s.selectedTakeId);
  const playingId = useTakes((s) => s.playingTakeId);
  const t = useLang();
  const takes = filterTakes(allTakes, search);
  const selected = takes.find((t) => t.id === selectedId) ?? null;
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    void refreshTakes();
    return () => takeActions.stopPlaying();
  }, []);
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  return (
    <>
      <div className="table table--takes">
        <div className="table__head" aria-hidden="true">
          <span />
          <span>{t.library.songTitle}</span>
          <span>{t.library.when}</span>
          <span>{t.library.whatPlays}</span>
          <span className="table__num">{t.library.length}</span>
        </div>
        <ul ref={listRef} className="table__body" aria-label={t.library.takes} data-list="takes">
          {takes.map((take) => (
            <li key={take.id}>
              <button
                type="button"
                className="trow"
                aria-current={take.id === selectedId}
                onClick={() => takeActions.select(take.id)}
                onDoubleClick={() => takeActions.togglePlay(take.id)}
              >
                <span className="trow__lead">{take.id === playingId ? <AudioLines size={16} /> : <Mic size={16} />}</span>
                <span className="trow__title">
                  <span className="trow__name">{take.title}</span>
                </span>
                <span className="trow__cell">{takeWhen(take.createdAt)}</span>
                <span className="trow__cell">{take.hasBand ? t.library.guitarAndSong : t.library.guitarWithoutSong}</span>
                <span className="trow__cell trow__num num">{fmtTime(take.duration)}</span>
              </button>
            </li>
          ))}
          {!takes.length && <li className="table__empty">{allTakes.length ? t.library.nothingFound : t.library.noTakes}</li>}
        </ul>
      </div>
      {selected && <TakeInfo key={selected.id} take={selected} />}
    </>
  );
}

const LIST_ICONS: Record<LibraryList, LucideIcon> = { all: ListMusic, favorite: Heart, learn: GraduationCap, set: ListOrdered, takes: Mic };

/** The lists on the left (← / → step through them): the songs' own, then the takes. */
function Lists() {
  const list = useRuntime((s) => s.libraryList);
  const songs = useLibrary((s) => s.songs);
  const setlist = useSettings((s) => s.setlist);
  const takes = useTakes((s) => s.takes.length);
  const t = useLang();
  const count = (l: LibraryList) => (l === 'takes' ? takes : filterSongs(songs, l, '', setlist).length);
  // The takes are fetched when their list opens: fetched here too, for the count beside it.
  useEffect(() => void refreshTakes(), []);
  return (
    <nav className="lib__lists" aria-label={t.library.listsLabel}>
      {LIST_ORDER.map((l) => {
        const Icon = LIST_ICONS[l];
        return (
          <button
            key={l}
            type="button"
            className={`lib__list${l === 'takes' ? ' lib__list--takes' : ''}`}
            aria-current={l === list}
            title={withKey(t.library.nextList, '← / →')}
            onClick={() => funActions.setLibraryList(l)}
          >
            <Icon size={16} />
            <span>{t.library.lists[l]}</span>
            <span className="lib__count num">{count(l)}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** What a row carries at its end: the lists the song is in. */
function RowMarks({ song, setlist, list, t }: { song: Song; setlist: string[]; list: LibraryList; t: Dict }) {
  const place = setlist.indexOf(song.id);
  return (
    <span className="trow__marks">
      {song.lists?.includes('learn') && (
        <span title={t.library.markLearn}>
          <GraduationCap size={14} />
        </span>
      )}
      {place >= 0 && list !== 'set' && (
        <span className="num" title={t.library.markSet(place + 1)}>
          {place + 1}
        </span>
      )}
      {song.lists?.includes('favorite') && (
        <span className="trow__fav" title={t.library.markFavorite}>
          <Heart size={14} fill="currentColor" />
        </span>
      )}
    </span>
  );
}

/**
 * Songs: the lists on the left, the table of the list in the middle with the search and Add song
 * over it, the highlighted song's properties on the right. ↑ ↓ move, Enter plays.
 */
export function LibraryScreen() {
  const allSongs = useLibrary((s) => s.songs);
  const list = useRuntime((s) => s.libraryList);
  const search = useRuntime((s) => s.search);
  const setlist = useSettings((s) => s.setlist);
  const songs = filterSongs(allSongs, list, search, setlist);
  const service = useLibrary((s) => s.service);
  const selectedId = useLibrary((s) => s.selectedId);
  const patch = useLibrary((s) => s.patch);
  const openSongNow = useSong((s) => s.song);
  const t = useLang();
  const openId = openSongNow?.id;
  // The open song's own copy has the newest edits (bookmarks, notes) before the list refreshes.
  const listed = allSongs.find((s) => s.id === selectedId) ?? null;
  const selected = listed && openSongNow?.id === listed.id ? { ...listed, ...openSongNow, stems: listed.stems } : listed;

  // ↑ / ↓ keep the highlighted song in view.
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, list]);

  return (
    <main className="lib">
      <Lists />
      <section className="lib__main">
        <LibraryBar />
        {service === 'offline' && <p className="lib__offline">{t.service.offline}</p>}
        <SetupNote />
        <div className="lib__body">
          {list === 'takes' ? (
            <TakesBody />
          ) : (
            <>
              <div className="table">
                <div className="table__head" aria-hidden="true">
                  <span />
                  <span>{t.library.songTitle}</span>
                  <span>{t.library.artist}</span>
                  <span>{t.library.key}</span>
                  <span className="table__num">BPM</span>
                  <span className="table__num">{t.library.length}</span>
                  <span />
                </div>
                <ul ref={listRef} className="table__body" aria-label={t.library.songList} data-list={list}>
                  {songs.map((song, i) => {
                    const status = rowStatus(song, t);
                    const tempo = songTempo(song);
                    return (
                      <li key={song.id}>
                        <button
                          type="button"
                          className={`trow${song.id === openId ? ' trow--open' : ''}`}
                          aria-current={song.id === selectedId}
                          onClick={() => patch({ selectedId: song.id })}
                          onDoubleClick={() => void openSong(song.id)}
                        >
                          <span className="trow__lead num" title={song.id === openId ? t.library.open : undefined}>
                            {song.id === openId ? <AudioLines size={16} /> : list === 'set' ? setlist.indexOf(song.id) + 1 : i + 1}
                          </span>
                          <span className="trow__title">
                            <span className="trow__name">{song.title}</span>
                            {status && (
                              <span className={`trow__status${status.error ? ' trow__status--error' : ''}`} title={status.text}>
                                {status.text}
                              </span>
                            )}
                          </span>
                          <span className="trow__cell">{song.artist || t.library.unknownArtist}</span>
                          <span className="trow__cell num">{songKey(song)}</span>
                          <span className="trow__cell trow__num num">{tempo ?? ''}</span>
                          <span className="trow__cell trow__num num">{fmtTime(song.duration)}</span>
                          <RowMarks song={song} setlist={setlist} list={list} t={t} />
                        </button>
                      </li>
                    );
                  })}
                  {!songs.length && (
                    <li className="table__empty">
                      {!allSongs.length ? (
                        <div className="empty">
                          <ListMusic size={36} />
                          <p className="empty__title">{t.library.noSongsTitle}</p>
                          <p className="empty__text">{t.library.noSongs}</p>
                        </div>
                      ) : search ? (
                        t.library.nothingFound
                      ) : list === 'set' ? (
                        t.library.setEmpty
                      ) : (
                        t.library.listEmpty(t.library.lists[list], list === 'favorite' ? 'F' : 'W')
                      )}
                    </li>
                  )}
                </ul>
              </div>
              {selected && <SongInfo song={selected} />}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
