import { addAmpFiles } from './ampFiles';
import { runtimeInfo, soundMayStart } from './boot';
import { LucideProvider } from 'lucide-react';
import { useEffect, useState } from 'react';
import { classifyDrop } from '../audio/assetFiles';
import { listUserAssets } from '../audio/assets';
import { bindEngine } from '../audio/bindings';
import { engine } from '../audio/engine';
import { L } from '../i18n';
import { deleteSongTwice, songActions } from '../song/actions';
import { funActions, visibleSongs } from '../song/funActions';
import { bindFun } from '../song/funBindings';
import { textActions } from '../song/textActions';
import { bindSong } from '../song/bindings';
import { importFiles } from '../song/importSong';
import { songPlayer } from '../song/player';
import { isTabSong } from '../song/types';
import { readWavInfo } from '../song/wav';
import { recorder } from '../record/recorder';
import { takeActions } from '../record/takeActions';
import { startLibraryPolling, useLibrary } from '../state/library';
import { useRuntime, type View } from '../state/runtime';
import { useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { AmpScreen } from '../ui/AmpScreen';
import { SettingsScreen } from '../ui/SettingsScreen';
import { LibraryScreen } from '../ui/LibraryScreen';
import { BigTuner, DropZone, ToastView } from '../ui/Overlays';
import { KeysSheet } from '../ui/KeysSheet';
import { AboutSheet } from '../ui/AboutSheet';
import { SongScreen } from '../ui/SongScreen';
import { StageOverlay } from '../ui/StageOverlay';
import { StartOverlay } from '../ui/StartOverlay';
import { Rail } from '../ui/Rail';
import { StatusBar } from '../ui/StatusBar';
import { keyToAction, type Action } from './keys';

const toggleView = (target: View) => {
  const rt = useRuntime.getState();
  rt.patch({ view: rt.view === target ? 'song' : target });
};

function moveSelection(dir: 1 | -1): void {
  if (useRuntime.getState().libraryList === 'takes') return takeActions.move(dir);
  const { selectedId, patch } = useLibrary.getState();
  const songs = visibleSongs();
  if (!songs.length) return;
  const index = songs.findIndex((s) => s.id === selectedId);
  patch({ selectedId: songs[Math.min(songs.length - 1, Math.max(0, index + dir))].id });
}

async function openSelected(): Promise<void> {
  // Enter in «Записи» plays the highlighted take.
  if (useRuntime.getState().libraryList === 'takes') return takeActions.togglePlay();
  const { selectedId } = useLibrary.getState();
  if (!selectedId) return;
  // Enter in «Сет-лист» plays the set from this song.
  if (useRuntime.getState().libraryList === 'set') return funActions.playSet();
  await useSong.getState().openSong(selectedId);
  useRuntime.getState().patch({ view: 'song' });
}

function runAction(action: Action): void {
  const rt = useRuntime.getState();
  const st = useSettings.getState();
  if (rt.status !== 'running') {
    if (action === 'primary' || action === 'confirm') void engine.start();
    return;
  }
  songPlayer.resume();
  switch (action) {
    case 'preset1':
    case 'preset2':
    case 'preset3':
    case 'preset4':
      st.selectPreset(Number(action.slice(-1)) - 1);
      break;
    case 'presetPrev':
      st.stepPreset(-1);
      break;
    case 'presetNext':
      st.stepPreset(1);
      break;
    case 'volUp':
      st.setMasterDb(st.masterDb + 1);
      break;
    case 'volDown':
      st.setMasterDb(st.masterDb - 1);
      break;
    case 'guitarVolUp':
      st.setGuitarDb(st.guitarDb + 1);
      break;
    case 'guitarVolDown':
      st.setGuitarDb(st.guitarDb - 1);
      break;
    case 'songVolUp':
      songActions.songVolume(1);
      break;
    case 'songVolDown':
      songActions.songVolume(-1);
      break;
    case 'mute':
      rt.patch({ muted: !rt.muted });
      break;
    case 'keys':
      rt.patch({ keysOpen: !rt.keysOpen });
      break;
    case 'toggleTuner':
      rt.patch({ bigTuner: !rt.bigTuner });
      break;
    case 'toggleInput':
      toggleView('input');
      break;
    case 'toggleLibrary':
      toggleView('library');
      break;
    case 'toggleAmp':
      toggleView('amp');
      break;
    case 'trimListen':
      rt.patch({ trimListening: !rt.trimListening });
      break;
    case 'back':
      if (rt.keysOpen) rt.patch({ keysOpen: false });
      else if (rt.aboutOpen) rt.patch({ aboutOpen: false });
      else if (rt.trimListening) rt.patch({ trimListening: false });
      else if (rt.stage) textActions.toggleStage();
      else if (rt.bigTuner) rt.patch({ bigTuner: false });
      else if (rt.noteEdit !== null) rt.patch({ noteEdit: null });
      else if (rt.view !== 'song') rt.patch({ view: 'song' });
      else if (rt.songSettings || useSong.getState().mixerOpen) songActions.closePanels();
      else if (rt.queue) funActions.stopQueue();
      break;
    case 'confirm':
      if (rt.view === 'input') {
        st.markSetupDone();
        rt.patch({ view: 'song' });
      } else if (rt.view === 'library') {
        void openSelected();
      }
      break;
    case 'primary':
      songActions.togglePlay();
      break;
    case 'seekBack':
      songActions.seekStep(-1);
      break;
    case 'seekFwd':
      songActions.seekStep(1);
      break;
    case 'home':
      songActions.home();
      break;
    case 'loopA':
      songActions.markA();
      break;
    case 'loopB':
      songActions.markB();
      break;
    case 'loopToggle':
      songActions.toggleLoop();
      break;
    case 'slower':
      songActions.stepSpeed(-1);
      break;
    case 'faster':
      songActions.stepSpeed(1);
      break;
    case 'pitchDown':
      songActions.stepPitch(-1, false);
      break;
    case 'pitchUp':
      songActions.stepPitch(1, false);
      break;
    case 'centsDown':
      songActions.stepPitch(-1, true);
      break;
    case 'centsUp':
      songActions.stepPitch(1, true);
      break;
    case 'guitarToggle':
      songActions.toggleGuitar();
      break;
    case 'guitarSolo':
      songActions.soloGuitar();
      break;
    case 'bookmarkAdd':
      songActions.addBookmark();
      break;
    case 'bookmarkNext':
      songActions.nextBookmark();
      break;
    case 'exportBacking':
      void songActions.exportBacking();
      break;
    case 'nextModel':
      songActions.nextModel();
      break;
    case 'listUp':
      moveSelection(-1);
      break;
    case 'listDown':
      moveSelection(1);
      break;
    case 'deleteSong': {
      if (rt.libraryList === 'takes') {
        void takeActions.deleteTwice();
        break;
      }
      const id = useLibrary.getState().selectedId;
      if (id) void deleteSongTwice(id);
      break;
    }
    case 'modeToggle':
      songActions.toggleMode();
      break;
    case 'hintNext':
      songActions.nextHint();
      break;
    case 'hintsHide':
      songActions.hideHints();
      break;
    case 'clickToggle':
      songActions.toggleClick();
      break;
    case 'countInToggle':
      songActions.toggleCountIn();
      break;
    case 'simpleToggle':
      songActions.toggleSimple();
      break;
    case 'capoDown':
      songActions.stepCapo(-1);
      break;
    case 'capoUp':
      songActions.stepCapo(1);
      break;
    case 'barShiftBack':
      songActions.shiftBars(-1);
      break;
    case 'barShiftFwd':
      songActions.shiftBars(1);
      break;
    case 'tuningNext':
      songActions.nextTuning();
      break;
    case 'fretView':
      songActions.toggleNeck();
      break;
    case 'neckView': {
      st.stepNeckView();
      songActions.showNeck();
      const view = useSettings.getState().neckView;
      const t = L().shell;
      rt.showToast(view === 'shape' ? t.neckShape : view === 'chord' ? t.neckChord : t.neckScale);
      break;
    }
    case 'degreesToggle':
      st.toggleDegrees();
      rt.showToast(useSettings.getState().degrees ? L().shell.degreesOn : L().shell.degreesOff);
      break;
    case 'voicingNext':
      songActions.nextVoicing();
      break;
    case 'toneMatchToggle':
      songActions.toggleToneMatch();
      break;
    // In «Ноты» Q and Shift+← / → work on the solo's phrases instead of the song's parts.
    case 'loopSection':
      if (inNotes()) funActions.loopPhrase();
      else songActions.loopSection();
      break;
    case 'sectionPrev':
      if (inNotes()) funActions.stepPhrase(-1);
      else songActions.stepSection(-1);
      break;
    case 'sectionNext':
      if (inNotes()) funActions.stepPhrase(1);
      else songActions.stepSection(1);
      break;
    case 'viewNext':
      textActions.nextView();
      break;
    case 'anchorHere':
      textActions.anchorHere();
      break;
    case 'anchorClear':
      textActions.anchorClear();
      break;
    case 'tabTrackNext':
      textActions.nextTabTrack();
      break;
    case 'tabNotation':
      textActions.toggleNotation();
      break;
    case 'stage':
      textActions.toggleStage();
      break;
    case 'repeatToggle':
      funActions.toggleRepeat();
      break;
    case 'speedTrainer':
      funActions.toggleSpeedTrainer();
      break;
    case 'randomSong':
      funActions.randomSong();
      break;
    case 'queueNext':
      funActions.next();
      break;
    case 'libraryTabPrev':
      funActions.stepLibraryList(-1);
      break;
    case 'libraryTabNext':
      funActions.stepLibraryList(1);
      break;
    case 'favoriteToggle':
      funActions.toggleSongList('favorite');
      break;
    case 'learnToggle':
      funActions.toggleSongList('learn');
      break;
    case 'setToggle':
      funActions.toggleSet();
      break;
    case 'setUp':
      funActions.moveInSet(-1);
      break;
    case 'setDown':
      funActions.moveInSet(1);
      break;
    case 'radio':
      funActions.radio();
      break;
    case 'searchFocus':
      funActions.focusSearch();
      break;
    case 'recordToggle':
      recorder.toggle();
      break;
  }
}

const inNotes = () => useSong.getState().song?.player.view === 'notes';

/** Keys typed into text fields and dropdowns belong to them, not to the shortcuts. */
function ownsKeyboard(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return true;
  return target instanceof HTMLInputElement && target.type !== 'range';
}

/**
 * A dropped tab is the open recording's tab only when its «Табы» view is on screen; anywhere else
 * it becomes a song of its own that the app plays by itself.
 */
function tabGoesToOpenSong(): boolean {
  const song = useSong.getState().song;
  return useRuntime.getState().view === 'song' && !!song && !isTabSong(song) && song.player.view === 'tab';
}

/** Songs and tab-songs go to the song service, .nam and short .wav (cabinets) to the amp, lyrics (and a tab in «Табы») to the open song. */
async function addDroppedFiles(files: File[]): Promise<void> {
  const songs: File[] = [];
  const amp: File[] = [];
  const own: File[] = [];
  for (const file of files) {
    const wav = file.name.toLowerCase().endsWith('.wav')
      ? readWavInfo(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()), file.size)
      : null;
    const kind = classifyDrop(file.name, wav);
    if (kind === 'song' || (kind === 'tab' && !tabGoesToOpenSong())) songs.push(file);
    else if (kind === 'tab' || kind === 'lyrics') own.push(file);
    else if (kind) amp.push(file);
    else useRuntime.getState().showToast(L().shell.dropUnknown(file.name), 'warn');
  }
  for (const file of own) {
    if (classifyDrop(file.name, null) === 'tab') await textActions.addTabFile(file);
    else await textActions.addLyricsFile(file);
  }
  await addAmpFiles(amp);
  await importFiles(songs);
}

export function App() {
  const view = useRuntime((s) => s.view);
  const status = useRuntime((s) => s.status);
  const [dragging, setDragging] = useState(false);

  useEffect(() => bindEngine(), []);
  useEffect(() => bindSong(), []);
  useEffect(() => bindFun(), []);
  useEffect(() => startLibraryPolling(), []);
  // In the Strum window the sound may start without a key press (WebView2 runs with no autoplay
  // gate): no start screen. Where it may not, the start screen stays, as in a browser.
  useEffect(() => {
    if (!runtimeInfo().shell) return;
    void soundMayStart().then((may) => {
      if (may && useRuntime.getState().status === 'idle') void engine.start();
    });
  }, []);

  useEffect(() => {
    listUserAssets()
      .then((userAssets) => useRuntime.getState().patch({ userAssets }))
      .catch(() => undefined);
  }, []);

  // First launch starts on the "Вход" screen; later launches go straight to the song.
  useEffect(() => {
    if (status === 'running' && !useSettings.getState().setupDone) useRuntime.getState().patch({ view: 'input' });
  }, [status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ownsKeyboard(e.target)) return;
      // A button reached with Tab keeps Space / Enter for itself (mouse clicks blur buttons).
      if (e.target instanceof HTMLButtonElement && ['Space', 'Enter', 'NumpadEnter'].includes(e.code)) return;
      const action = keyToAction(e, useRuntime.getState().view);
      if (!action) return;
      e.preventDefault();
      const repeatable = ['volUp', 'volDown', 'songVolUp', 'songVolDown', 'guitarVolUp', 'guitarVolDown', 'seekBack', 'seekFwd', 'listUp', 'listDown'];
      if (e.repeat && !repeatable.includes(action)) return;
      runAction(action);
    };
    // A clicked button or slider would otherwise keep focus and swallow space / arrows.
    const onPointerUp = () => {
      const el = document.activeElement;
      if (el instanceof HTMLButtonElement || (el instanceof HTMLInputElement && el.type === 'range')) el.blur();
    };
    // Ctrl+V on the song screen: lyrics with chords, or a text tab (text fields keep their own paste).
    const onPaste = (e: ClipboardEvent) => {
      if (ownsKeyboard(e.target) || useRuntime.getState().view !== 'song') return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text.trim()) return;
      e.preventDefault();
      void textActions.pasteText(text);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('paste', onPaste);
    };
  }, []);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      void addDroppedFiles(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <LucideProvider size={18} strokeWidth={1.75}>
      <div className="app">
        <Rail />
        <div className="app__main">
          {view === 'input' ? <SettingsScreen /> : view === 'amp' ? <AmpScreen /> : view === 'library' ? <LibraryScreen /> : <SongScreen />}
          <StatusBar />
        </div>
        <BigTuner />
        <KeysSheet />
        <AboutSheet />
        <StageOverlay />
        <StartOverlay />
        <DropZone active={dragging} />
        <ToastView />
      </div>
    </LucideProvider>
  );
}
