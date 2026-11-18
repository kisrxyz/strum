import { SetupNote } from './SetupNote';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { L, withKey, type Dict } from '../i18n';
import { messageText } from '../i18n/messages';
import { useLang } from '../i18n/useLang';
import { keyName, keySpelling } from '../music/keys';
import { TUNINGS } from '../music/tunings';
import { deleteSongTwice, readyModels, songActions } from '../song/actions';
import { api } from '../song/api';
import { fmtTime } from '../song/format';
import { funActions } from '../song/funActions';
import { LIST_ORDER, filterSongs, type LibraryList } from '../song/setlist';
import { isTabSong, MODELS, MODEL_NAMES, type ModelId, type Song, type StemsInfo, type Take, type TuningId } from '../song/types';
import { NUDGE_MS, takeActions, takeWhen } from '../record/takeActions';
import { searchKey } from '../song/setlist';
import { refreshLibrary, useLibrary } from '../state/library';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { refreshTakes, useTakes } from '../state/takes';
import { AddSongButton } from './AddSongButton';

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
      const facts = [songKey(song), songTempo(song) ? `${songTempo(song)} BPM` : ''].filter(Boolean).join(' · ');
      return t.library.chordsReady(!!info.source && info.source !== 'mix', facts);
    }
  }
}

/** The separation's state for a row of the list: only while it runs, waits, failed or never ran. */
function rowStatus(song: Song, t: Dict): { text: string; error: boolean } | null {
  if (isTabSong(song)) return { text: t.library.tabSong, error: false };
  const entries = Object.entries(song.stems) as [ModelId, StemsInfo][];
  const running = entries.find(([, info]) => info.status === 'running');
  if (running) return { text: t.library.separating(percent(running[1].progress)), error: false };
  if (entries.some(([, info]) => info.status === 'queued')) return { text: t.library.waitingToSeparate, error: false };
  const failed = entries.find(([, info]) => info.status === 'error');
  if (failed && !readyModels(song.stems).length) return { text: messageText(failed[1].error) || t.library.separationFailed, error: true };
  if (!entries.length) return { text: t.library.notSeparated, error: false };
  return null;
}

/** The marks of a row: the lists it is in and its place in the set-list (shown as a number in «Сет-лист» itself). */
function rowMarks(song: Song, setlist: string[], list: LibraryList, t: Dict): string {
  const marks: string[] = [];
  if (song.lists?.includes('favorite')) marks.push(t.library.markFavorite);
  if (song.lists?.includes('learn')) marks.push(t.library.markLearn);
  const place = setlist.indexOf(song.id);
  if (place >= 0 && list !== 'set') marks.push(t.library.markSet(place + 1));
  return marks.join(', ');
}

const tuningShort = (id: TuningId, t: Dict): string => t.library.tuningShort[id] ?? t.library.tuningShort.standard;

async function openSong(id: string): Promise<void> {
  await useSong.getState().openSong(id);
  useRuntime.getState().patch({ view: 'song' });
}

/** Enter (in the search too) and «Играть»: open the highlighted song; in «Сет-лист» play the set from it. */
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
      className={`lib-card__${field}`}
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

function SongCard({ song }: { song: Song }) {
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
    <aside className="lib-card" aria-label={t.library.card}>
      <div className="lib-card__names">
        <h2>
          <NameField song={song} field="title" label={t.library.songTitle} />
        </h2>
        <NameField song={song} field="artist" label={t.library.artist} />
      </div>

      <dl className="lib-card__facts">
        <div>
          <dt>{t.library.length}</dt>
          <dd className="num">{fmtTime(song.duration)}</dd>
        </div>
        <div>
          <dt>{t.library.key}</dt>
          <dd>{key || '—'}</dd>
        </div>
        <div>
          <dt>{t.library.tempo}</dt>
          <dd className="num">{tempo ?? '—'}</dd>
        </div>
        <div>
          <dt>{t.library.tuning}</dt>
          <dd title={tuning}>
            {tuningShort(song.player.tuning, t)}
            {song.player.capo > 0 && <span className="lib-card__capo">{t.library.capo(song.player.capo)}</span>}
          </dd>
        </div>
      </dl>

      <ul className="lib-card__ready" aria-label={t.library.ready}>
        {ready.map((r) => (
          <li key={r.name} data-on={r.on} title={r.hint}>
            {r.name}
          </li>
        ))}
      </ul>

      <div className="lib-card__go">
        <button
          type="button"
          className="btn btn--primary btn--big"
          title={list === 'set' ? t.library.playSetTip : undefined}
          onClick={() => playSelected()}
        >
          {list === 'set' ? t.library.playSet : t.library.play} <kbd>Enter</kbd>
        </button>
      </div>

      <SongLists song={song} />

      <textarea
        key={`${song.id}-notes`}
        className="input-text lib-card__notes"
        rows={2}
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

      <div className="lib-card__foot">
        {!tabSong && (
          <button type="button" className="link" aria-expanded={more} onClick={() => setMore(!more)}>
            {t.library.processing}
          </button>
        )}
        <button type="button" className="link" title={withKey(t.library.deleteSongTip, 'Delete')} onClick={() => void deleteSongTwice(song.id)}>
          {t.common.delete}
        </button>
      </div>

      {more && !tabSong && <Processing song={song} />}
    </aside>
  );
}

/** «Разделение и анализ»: each model's stems, the bars and chords, their timings and video memory. */
function Processing({ song }: { song: Song }) {
  const t = useLang();
  const analysisBusy = song.analysis?.status === 'queued' || song.analysis?.status === 'running';
  return (
    <div className="lib-card__more">
      {MODELS.map((model: ModelId) => {
        const info = song.stems[model];
        const busy = info?.status === 'queued' || info?.status === 'running';
        return (
          <div key={model} className="lib-job">
            <span className="lib-job__name">
              {MODEL_NAMES[model]}
              {song.activeModel === model && <span className="lib-job__playing"> · {t.library.playing}</span>}
            </span>
            <span className="lib-job__state">{stemLine(info, t)}</span>
            <span className="lib-job__action">
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
            {info?.note && <span className="lib-job__note">{messageText(info.note)}</span>}
          </div>
        );
      })}
      <div className="lib-job">
        <span className="lib-job__name">{t.library.barsAndChords}</span>
        <span className="lib-job__state">{analysisLine(song, t)}</span>
        <span className="lib-job__action">
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

/** The song's lists: «Избранное», «Хочу выучить», the set-list (keys F, W, S on this screen), and its order in «Сет-лист». */
function SongLists({ song }: { song: Song }) {
  const setlist = useSettings((s) => s.setlist);
  const list = useRuntime((s) => s.libraryList);
  const t = useLang();
  const lists = song.lists ?? [];
  const place = setlist.indexOf(song.id);
  const toggle = (on: boolean, text: string, key: string, onClick: () => void) => (
    <button type="button" className="btn" aria-pressed={on} title={withKey(text, key)} onClick={onClick}>
      {text}
    </button>
  );
  return (
    <div className="lib-card__lists" role="group" aria-label={t.library.listsOfSong}>
      {toggle(lists.includes('favorite'), lists.includes('favorite') ? t.library.inFavorites : t.library.toFavorites, 'F', () =>
        funActions.toggleSongList('favorite'),
      )}
      {toggle(lists.includes('learn'), t.library.learning, 'W', () => funActions.toggleSongList('learn'))}
      {toggle(place >= 0, place >= 0 ? t.library.inSet(place + 1) : t.library.toSet, 'S', () => funActions.toggleSet())}
      {list === 'set' && place >= 0 && (
        <span className="lib-card__order">
          <button
            type="button"
            className="btn btn--quiet"
            title={withKey(t.library.earlierInSet, 'Shift+↑')}
            aria-label={t.library.earlierInSet}
            disabled={place === 0}
            onClick={() => funActions.moveInSet(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            title={withKey(t.library.laterInSet, 'Shift+↓')}
            aria-label={t.library.laterInSet}
            disabled={place === setlist.length - 1}
            onClick={() => funActions.moveInSet(1)}
          >
            ↓
          </button>
        </span>
      )}
    </div>
  );
}

/** «Песни» with the count, the search (/), a random song (Shift+L), the radio (R) and «Добавить песню». */
function LibraryHead({ total }: { total: number }) {
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
    <header className="lib__head">
      <h1>
        {t.library.title} <span className="lib__count num">{total}</span>
      </h1>
      <div className="lib__tools">
        <label className="lib__search">
          <input
            className="input-text library__search"
            type="search"
            value={search}
            placeholder={t.library.search}
            aria-label={t.library.searchLabel}
            title={withKey(t.library.searchLabel, '/')}
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
        <button type="button" className="btn" title={withKey(t.library.randomTip, 'Shift+L')} onClick={() => funActions.randomSong()}>
          {t.library.random}
        </button>
        <button type="button" className="btn" title={withKey(t.library.radioTip, 'R')} onClick={() => funActions.radio()}>
          {t.library.radio}
        </button>
        <AddSongButton />
      </div>
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

/** «Записи»: one take — listen (Enter), move the guitar against the song, download, delete. */
function TakeCard({ take }: { take: Take }) {
  const playing = useTakes((s) => s.playingTakeId === take.id);
  const version = useTakes((s) => s.versions[take.id] ?? 0);
  const audio = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const t = useLang();
  // A new mp3 (after «Гитара раньше / позже») goes on from the same place.
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

  return (
    <aside className="lib-card take-card" aria-label={t.library.take}>
      <div className="lib-card__names">
        <h2 className="take-card__title">{take.title}</h2>
        {take.artist && <p className="take-card__artist">{take.artist}</p>}
      </div>

      <dl className="lib-card__facts">
        <div>
          <dt>{t.library.when}</dt>
          <dd>{takeWhen(take.createdAt)}</dd>
        </div>
        <div>
          <dt>{t.library.length}</dt>
          <dd className="num">{fmtTime(take.duration)}</dd>
        </div>
        <div>
          <dt>{t.library.whatPlays}</dt>
          <dd>{take.hasBand ? t.library.guitarAndSong : t.library.guitarOnly}</dd>
        </div>
      </dl>

      <div className="lib-card__go">
        <button type="button" className="btn btn--primary btn--big" onClick={() => takeActions.togglePlay(take.id)}>
          {playing ? t.library.stop : t.library.listen} <kbd>Enter</kbd>
        </button>
      </div>

      <label className="slider slider--inline take-card__seek">
        <span className="slider__label">{t.library.position}</span>
        <input
          type="range"
          min={0}
          max={Math.max(0.1, take.duration)}
          step={0.1}
          value={Math.min(time, take.duration)}
          aria-label={t.library.positionLabel}
          onChange={(e) => seek(Number(e.currentTarget.value))}
        />
        <span className="slider__value num">{fmtTime(time)}</span>
      </label>

      {take.hasBand && (
        <div className="take-card__nudge">
          <span className="take-card__nudge-label">{t.library.nudgeAsk}</span>
          <div className="take-card__nudge-row" role="group" aria-label={t.library.nudgeLabel}>
            <button type="button" className="btn" onClick={() => void takeActions.nudge(take.id, -NUDGE_MS)}>
              {t.library.guitarEarlier}
            </button>
            <span className="take-card__offset num" title={t.library.offsetTip}>
              {offsetText(take.guitarOffsetMs, t)}
            </span>
            <button type="button" className="btn" onClick={() => void takeActions.nudge(take.id, NUDGE_MS)}>
              {t.library.guitarLater}
            </button>
          </div>
        </div>
      )}

      <div className="lib-card__foot">
        <button type="button" className="link" title={t.library.downloadTip} onClick={() => takeActions.download(take.id)}>
          {t.library.download}
        </button>
        <button type="button" className="link" title={withKey(t.library.deleteTakeTip, 'Delete')} onClick={() => void takeActions.deleteTwice(take.id)}>
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

/** «Записи»: the takes, newest first. */
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
    <div className="lib__body">
      <ul ref={listRef} className="lib-list" aria-label={t.library.takes} data-list="takes">
        {takes.map((take) => (
          <li key={take.id}>
            <button
              type="button"
              className="lib-row"
              aria-current={take.id === selectedId}
              onClick={() => takeActions.select(take.id)}
              onDoubleClick={() => takeActions.togglePlay(take.id)}
            >
              <span className="lib-row__main">
                <span className="lib-row__title">{take.title}</span>
                <span className="lib-row__sub">
                  <span className="lib-row__artist">{takeWhen(take.createdAt)}</span>
                  {!take.hasBand && <span className="lib-row__mark"> · {t.library.guitarWithoutSong}</span>}
                  {take.id === playingId && <span className="lib-row__mark"> · {t.library.playing}</span>}
                </span>
              </span>
              <span className="lib-row__fig num">{fmtTime(take.duration)}</span>
            </button>
          </li>
        ))}
        {!takes.length && (
          <li className="lib-list__empty">
            {allTakes.length ? t.library.nothingFound : t.library.noTakes}
          </li>
        )}
      </ul>
      {selected && <TakeCard key={selected.id} take={selected} />}
    </div>
  );
}

/** The lists as a segmented row (← / →). */
function ListTabs() {
  const list = useRuntime((s) => s.libraryList);
  const songs = useLibrary((s) => s.songs);
  const setlist = useSettings((s) => s.setlist);
  const takes = useTakes((s) => s.takes.length);
  const t = useLang();
  const count = (l: LibraryList) => (l === 'takes' ? takes : filterSongs(songs, l, '', setlist).length);
  return (
    <div className="seg lib__tabs" role="group" aria-label={t.library.listsLabel}>
      {LIST_ORDER.map((l) => (
        <button key={l} type="button" aria-pressed={l === list} title={withKey(t.library.nextList, '← / →')} onClick={() => funActions.setLibraryList(l)}>
          {t.library.lists[l]} <span className="lib__tabcount num">{count(l)}</span>
        </button>
      ))}
    </div>
  );
}

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

  // The screen takes the window's height below the top bar: the list scrolls, the card stays.
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const fit = () => el.style.setProperty('--lib-top', `${Math.round(el.getBoundingClientRect().top + window.scrollY)}px`);
    fit();
    window.addEventListener('resize', fit);
    // The top bar may change its height while this screen is open.
    const observer = new ResizeObserver(fit);
    if (el.previousElementSibling) observer.observe(el.previousElementSibling);
    return () => {
      window.removeEventListener('resize', fit);
      observer.disconnect();
    };
  }, []);

  // ↑ / ↓ keep the highlighted song in view.
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, list]);

  return (
    <main ref={root} className="lib">
      <LibraryHead total={allSongs.length} />
      <ListTabs />
      {service === 'offline' && <p className="lib__offline">{t.service.offline}</p>}
      <SetupNote />
      {list === 'takes' ? (
        <TakesBody />
      ) : (
        <div className="lib__body">
          <ul ref={listRef} className="lib-list" aria-label={t.library.songList} data-list={list}>
            {songs.map((song) => {
              const status = rowStatus(song, t);
              const marks = rowMarks(song, setlist, list, t);
              const tempo = songTempo(song);
              return (
                <li key={song.id}>
                  <button
                    type="button"
                    className="lib-row"
                    aria-current={song.id === selectedId}
                    onClick={() => patch({ selectedId: song.id })}
                    onDoubleClick={() => void openSong(song.id)}
                  >
                    {list === 'set' && <span className="lib-row__place num">{setlist.indexOf(song.id) + 1}</span>}
                    <span className="lib-row__main">
                      <span className="lib-row__title">{song.title}</span>
                      <span className="lib-row__sub">
                        <span className="lib-row__artist">{song.artist || t.library.unknownArtist}</span>
                        {song.id === openId && <span className="lib-row__mark"> · {t.library.open}</span>}
                        {marks && <span className="lib-row__mark"> · {marks}</span>}
                        {status && (
                          <span className={`lib-row__status${status.error ? ' lib-row__status--error' : ''}`} title={status.text}>
                            {' · '}
                            {status.text}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="lib-row__fig">{songKey(song)}</span>
                    <span className="lib-row__fig num">{tempo ? `${tempo} BPM` : ''}</span>
                    <span className="lib-row__fig num">{fmtTime(song.duration)}</span>
                  </button>
                </li>
              );
            })}
            {!songs.length && (
              <li className="lib-list__empty">
                {!allSongs.length
                  ? t.library.noSongs
                  : search
                    ? t.library.nothingFound
                    : list === 'set'
                      ? t.library.setEmpty
                      : t.library.listEmpty(t.library.lists[list], list === 'favorite' ? 'F' : 'W')}
              </li>
            )}
          </ul>
          {selected && <SongCard song={selected} />}
        </div>
      )}
    </main>
  );
}
