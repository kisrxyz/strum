// Settings and runtime state drive the engine: the UI only changes state, never the engine directly.
import { TUNINGS } from '../music/tunings';
import { useRuntime } from '../state/runtime';
import { MainsDetector, type MainsHz } from '../dsp/mains';
import { currentPreset, guitarOutDb, useSettings, type SettingsData } from '../state/settings';
import { useSong } from '../state/song';
import { engine } from './engine';

/** The mains the hum filter notches: chosen by hand, or the one last heard. */
const mainsOf = (s: SettingsData): MainsHz => (s.mains === 'auto' ? s.mainsHz : s.mains);

/** How often a stretch of the input goes to the mains detector, ms. */
const MAINS_EVERY_MS = 1000;

/** The open song's tuning for the tuner (standard without a song). */
const songStrings = () => TUNINGS[useSong.getState().song?.player.tuning ?? 'standard'].strings;

export function bindEngine(): () => void {
  const offSettings = useSettings.subscribe((s, prev) => {
    // Kept even while stopped: the next start builds with it.
    if (s.inputTrimDb !== prev.inputTrimDb) engine.setInputTrim(s.inputTrimDb);
    if (mainsOf(s) !== mainsOf(prev)) engine.setMains(mainsOf(s));
    if (!engine.running) return;
    const preset = currentPreset(s);
    if (preset !== currentPreset(prev)) void engine.applyPreset(preset);
    if (guitarOutDb(s) !== guitarOutDb(prev)) engine.setMasterDb(guitarOutDb(s));
    if (s.channelMode !== prev.channelMode) engine.setChannelMode(s.channelMode);
    if (s.inputDeviceId !== prev.inputDeviceId) void engine.setInputDevice(s.inputDeviceId);
    if (s.outputDeviceId !== prev.outputDeviceId) void engine.setOutputDevice(s.outputDeviceId);
    if (s.a4 !== prev.a4) engine.setA4(s.a4);
    // The latency mode is the browser path's: the native engine's buffer is chosen on «Вход».
    if (s.latencyMode !== prev.latencyMode && engine.guitarPath !== 'native') void engine.restart();
    if (s.guitarEngine !== prev.guitarEngine) void engine.restart();
    if (s.nativeDevice !== prev.nativeDevice || s.nativeBuffer !== prev.nativeBuffer) engine.reopenNative();
  });
  const offRuntime = useRuntime.subscribe((r, prev) => {
    if (r.muted !== prev.muted) engine.setMuted(r.muted);
    if (r.toneOffsets !== prev.toneOffsets) engine.setToneOffsets(r.toneOffsets);
    // A new engine (first start, latency mode switch) gets the song's tone again.
    if (r.status === 'running' && prev.status !== 'running') engine.setToneOffsets(r.toneOffsets);
  });
  const offSong = useSong.subscribe((s, prev) => {
    if (s.song?.player.tuning !== prev.song?.player.tuning) engine.setTuning(songStrings());
  });
  engine.setTuning(songStrings());
  engine.setInputTrim(useSettings.getState().inputTrimDb);
  engine.setMains(mainsOf(useSettings.getState()));
  // While the mains is `auto`, quiet stretches of the input tell 50 Hz from 60 Hz (three in a row).
  const detector = new MainsDetector();
  const listen = setInterval(() => {
    const st = useSettings.getState();
    if (st.mains !== 'auto' || !engine.running) return;
    const window = engine.readHumWindow();
    if (!window) return;
    const heard = detector.push(window.samples, window.sampleRate);
    if (heard && heard !== st.mainsHz) st.setMainsHeard(heard);
  }, MAINS_EVERY_MS);
  return () => {
    clearInterval(listen);
    offSettings();
    offRuntime();
    offSong();
  };
}
