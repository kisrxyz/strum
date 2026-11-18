// alphaTab glue: draws the song's tab in one long line and moves its cursor with OUR player.
// alphaTab runs in «external media» mode: it never makes a sound, our player is the clock; each
// frame the song time is handed to it, and sync points tie the tab's bars to the recording's.
// Clicking in the tab seeks our player.
import { AlphaTabApi, LayoutMode, model, NotationElement, PlayerMode, ScrollMode, StaveProfile, type synth } from '@coderline/alphatab';
import { L } from '../i18n';
import type { FretPos } from '../music/fretboard';
import { readScore } from '../tab/load';
import { fixDrumParts, partStaves, tabBars, type MasterBarTicks, type PartStaves } from '../tab/score';
import type { SyncTime, TabBar } from '../tab/sync';

export interface TabEvents {
  /** The score is read: the names of its parts. */
  tracks(names: string[], tempo: number): void;
  /** The bars of the shown part in playback order (after each part change). */
  bars(bars: TabBar[]): void;
  /** The notes at the cursor and the next ones (6-string parts only). */
  notes(now: FretPos[], next: FretPos[]): void;
  /** A click in the tab: go to this song time, seconds. */
  seek(seconds: number): void;
  /** alphaTab could not read the file. */
  failed(message: string): void;
}

const HIDDEN = [
  NotationElement.ScoreTitle,
  NotationElement.ScoreSubTitle,
  NotationElement.ScoreArtist,
  NotationElement.ScoreAlbum,
  NotationElement.ScoreWords,
  NotationElement.ScoreMusic,
  NotationElement.ScoreWordsAndMusic,
  NotationElement.ScoreCopyright,
  NotationElement.GuitarTuning,
  NotationElement.TrackNames,
];

const PROFILES: Record<PartStaves, StaveProfile> = {
  tab: StaveProfile.Tab,
  'score-tab': StaveProfile.ScoreTab,
  score: StaveProfile.Score,
};

const css = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * Notes of a beat on our fretboard (string 0 = the lowest, frets from the nut: a tab counts them
 * from its capo); none for parts that are not a 6-string guitar.
 */
function fretNotes(beat: model.Beat | null | undefined): FretPos[] {
  const staff = beat?.voice.bar.staff;
  if (!beat || !staff || staff.tuning.length !== 6) return [];
  return beat.notes
    .filter((n) => !n.isTieDestination && n.fret >= 0)
    .map((n) => ({ string: n.string - 1, fret: n.fret + staff.capo }));
}

export class TabGlue {
  readonly api: AlphaTabApi;
  private score: model.Score | null = null;
  private track = 0;
  /** The notes above the tab (Shift+«'»). */
  private notation = false;
  private lastMs = Number.NaN;
  private playing = false;
  private destroyed = false;
  /** alphaTab asks the media to seek after the sync points or the shown part change too: only
   * a click in the tab should move the song, so seeks are ignored for a moment after those. */
  private quietUntil = 0;

  constructor(element: HTMLElement, scrollElement: HTMLElement, private readonly events: TabEvents) {
    const text = css('--text', '#e9ddcd');
    const dim = css('--text-3', '#8f7d6c');
    this.api = new AlphaTabApi(element, {
      core: { useWorkers: true, logLevel: 'error' },
      display: {
        layoutMode: LayoutMode.Horizontal,
        staveProfile: StaveProfile.Tab,
        // As big as the strip allows: about 100 px of strip per unit of scale (the tab line with
        // its tempo mark), so the frets are readable from the guitar's distance.
        scale: Math.min(2, Math.max(1, scrollElement.clientHeight / 100)),
        // One line in a low strip: no air above or below it.
        padding: [0, 6, 0, 6],
        firstSystemPaddingTop: 0,
        systemPaddingTop: 0,
        systemPaddingBottom: 0,
        lastSystemPaddingBottom: 0,
        firstNotationStaffPaddingTop: 0,
        lastNotationStaffPaddingBottom: 0,
        effectStaffPaddingTop: 0,
        effectStaffPaddingBottom: 0,
        resources: {
          mainGlyphColor: text,
          secondaryGlyphColor: dim,
          staffLineColor: dim,
          barSeparatorColor: dim,
          barNumberColor: dim,
          scoreInfoColor: dim,
        },
      },
      notation: {
        // One long line under the wave: no title block, no tuning or part names above it.
        elements: new Map(HIDDEN.map((element) => [element, false])),
      },
      player: {
        playerMode: PlayerMode.EnabledExternalMedia,
        enableCursor: true,
        enableAnimatedBeatCursor: true,
        enableUserInteraction: true,
        scrollElement,
        scrollMode: ScrollMode.Smooth,
        nativeBrowserSmoothScroll: false,
        scrollOffsetX: -Math.round(scrollElement.clientWidth * 0.22),
      },
    });

    this.api.scoreLoaded.on((score) => {
      this.score = score;
      this.events.tracks(
        score.tracks.map((t, i) => t.name || L().actions.tab.track(i + 1)),
        score.tempo,
      );
    });
    this.api.midiLoaded.on(() => this.reportBars());
    this.api.playedBeatChanged.on((beat) => this.events.notes(fretNotes(beat), fretNotes(beat.nextBeat)));
    this.api.error.on((error) => this.events.failed(L().actions.tab.readFailed(error.message ?? '')));
    this.api.playerReady.on(() => {
      const output = this.api.player?.output as synth.IExternalMediaSynthOutput | undefined;
      if (!output) return;
      output.handler = {
        backingTrackDuration: 0,
        playbackRate: 1,
        masterVolume: 0,
        seekTo: (ms: number) => {
          if (performance.now() >= this.quietUntil) this.events.seek(ms / 1000);
        },
        play: () => undefined,
        pause: () => undefined,
      };
      this.lastMs = Number.NaN;
    });
  }

  /** Reads a Guitar Pro / MusicXML file, or alphaTex text (Russian texts of old Guitar Pro files fixed). */
  load(data: Uint8Array, ext: string, track: number): void {
    this.track = track;
    this.hush();
    let score: model.Score;
    try {
      score = readScore(data, ext);
    } catch {
      this.events.failed(L().actions.tab.errors.unreadable);
      return;
    }
    fixDrumParts(score);
    this.setProfile(score.tracks[Math.min(track, score.tracks.length - 1)]);
    this.api.renderScore(score, [track]);
  }

  /** Shows another part (and its notes above the tab, or not). */
  show(track: number, notation: boolean): void {
    this.notation = notation;
    const score = this.score;
    if (!score) return; // load() sets the line up when the file is read
    const index = Math.min(track, score.tracks.length - 1);
    const profileChanged = this.setProfile(score.tracks[index]);
    this.hush();
    if (index !== this.track || profileChanged) {
      this.track = index;
      this.api.renderTracks([score.tracks[index]]);
    }
  }

  /** What the part's line shows: drums and parts without strings have no tab, only notes. True when it changed. */
  private setProfile(track: model.Track | undefined): boolean {
    const profile = PROFILES[partStaves(track, this.notation)];
    if (this.api.settings.display.staveProfile === profile) return false;
    this.api.settings.display.staveProfile = profile;
    this.api.updateSettings();
    return true;
  }

  private reportBars(): void {
    const score = this.score;
    const lookup = this.api.tickCache?.masterBars as unknown as MasterBarTicks[] | undefined;
    if (!score || !lookup) return;
    this.events.bars(tabBars(lookup, score.tracks[this.track] ?? null, score.tempo));
  }

  /** Ties the tab's bars to the recording: each tab bar starts at its time. */
  sync(times: SyncTime[]): void {
    const score = this.score;
    if (!score) return;
    for (const bar of score.masterBars) bar.syncPoints = undefined;
    for (const t of times) {
      const automation = new model.Automation();
      automation.type = model.AutomationType.SyncPoint;
      automation.ratioPosition = 0;
      const value = new model.SyncPointData();
      value.barOccurence = t.occurrence;
      value.millisecondOffset = Math.round(t.time * 1000);
      automation.syncPointValue = value;
      score.masterBars[t.index]?.addSyncPoint(automation);
    }
    this.hush();
    this.api.updateSyncPoints();
    this.lastMs = Number.NaN;
  }

  private hush(): void {
    this.quietUntil = performance.now() + 1500;
  }

  /** Each frame: the song time (seconds) for the cursor. */
  position(seconds: number): void {
    const output = this.api.player?.output as synth.IExternalMediaSynthOutput | undefined;
    const ms = seconds * 1000;
    if (!output || Math.abs(ms - this.lastMs) < 0.5) return;
    this.lastMs = ms;
    output.updatePosition(ms);
  }

  /** Our player started or stopped: alphaTab's cursor animates only while it «plays». */
  setPlaying(playing: boolean): void {
    if (playing === this.playing || !this.api.player) return;
    this.playing = playing;
    if (playing) this.api.play();
    else this.api.pause();
  }

  print(): void {
    this.api.print();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.api.destroy();
  }
}
