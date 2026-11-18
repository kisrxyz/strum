// Stage 4 bindings: «Повтори за мной» and «Разгон» follow the loop's passes, the set-list and the
// radio follow the end of each song. Like bindings.ts, the UI only changes stores; this drives the player.
import { dbToLin } from '../dsp/level';
import { L } from '../i18n';
import { useLibrary } from '../state/library';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { funActions, queueOpening } from './funActions';
import { songPlayer } from './player';
import { SPEED_MAX, loopActive, stepSpeed } from './schedule';
import { pruneSet } from './setlist';

/** The original guitar's gain in the «слушай» passes, or null when «Повтори за мной» cannot run. */
function repeatGain(): number | null {
  const { song, source } = useSong.getState();
  if (!useRuntime.getState().repeat || !song || !source || source === 'mix' || !loopActive(song.player.loop)) return null;
  return dbToLin(song.player.volumesDb.guitar ?? 0);
}

export function bindFun(): () => void {
  const applyRepeat = () => songPlayer.setRepeat(repeatGain());

  // «Разгон»: each time the loop comes round, 5 % faster; at 100 % it switches itself off.
  const offWrap = songPlayer.onLoopWrap(() => {
    const rt = useRuntime.getState();
    const song = useSong.getState().song;
    if (!rt.speedTrainer || !song) return;
    const speed = stepSpeed(song.player.speed, 1);
    useSong.getState().updatePlayer({ speed });
    if (speed >= SPEED_MAX) {
      rt.patch({ speedTrainer: false });
      rt.showToast(L().actions.practice.trainerDone(L().common.units.pct(100)));
    }
  });

  const offEnded = songPlayer.onEnded(() => funActions.songEnded());

  const offSong = useSong.subscribe((s, prev) => {
    const rt = useRuntime.getState();
    if (s.song?.id !== prev.song?.id) {
      rt.patch({ repeat: false, speedTrainer: false, noteEdit: null });
      // Another song opened by hand: the set-list or the radio stops quietly.
      const queue = rt.queue;
      if (queue && s.song && s.song.id !== queue.ids[queue.index] && !queueOpening()) rt.patch({ queue: null });
      applyRepeat();
      return;
    }
    if (!s.song || !prev.song) return;
    const p = s.song.player;
    const q = prev.song.player;
    if (p.loop !== q.loop && !loopActive(p.loop) && (rt.repeat || rt.speedTrainer)) {
      rt.patch({ repeat: false, speedTrainer: false });
    }
    if (p.loop !== q.loop || p.volumesDb !== q.volumesDb || s.source !== prev.source) applyRepeat();
    // The radio stops on a pause by hand (not at the end of a song, not while stems are reloaded).
    if (prev.playing && !s.playing && s.state === 'ready' && prev.state === 'ready' && rt.queue?.kind === 'radio') {
      if (songPlayer.position() < s.song.duration - 0.5) funActions.stopQueue();
    }
    // The edited note list changed (a note removed): an editor pointing past its end closes.
    if (rt.noteEdit !== null && s.song.guitarNotes !== prev.song.guitarNotes && s.song.guitarNotes && rt.noteEdit >= s.song.guitarNotes.length) {
      rt.patch({ noteEdit: null });
    }
  });

  const offRuntime = useRuntime.subscribe((r, prev) => {
    if (r.repeat !== prev.repeat) applyRepeat();
  });

  // Deleted songs leave the set-list (only with a list the service gave: not before it answered).
  const offLibrary = useLibrary.subscribe((lib, prev) => {
    if (lib.service !== 'online' || lib.songs === prev.songs) return;
    const st = useSettings.getState();
    const pruned = pruneSet(st.setlist, lib.songs.map((s) => s.id));
    if (pruned.length !== st.setlist.length) st.setSetlist(pruned);
  });

  return () => {
    offWrap();
    offEnded();
    offSong();
    offRuntime();
    offLibrary();
  };
}
