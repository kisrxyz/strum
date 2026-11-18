import { describe, expect, it } from 'vitest';
import { keyToAction } from './keys';

const views = ['song', 'library', 'amp', 'input'] as const;

describe('keyToAction', () => {
  it('opens the Keys sheet with F1 or ? on every screen; / still searches the songs', () => {
    for (const view of views) {
      expect(keyToAction({ code: 'F1' }, view)).toBe('keys');
      expect(keyToAction({ code: 'Slash', shiftKey: true }, view)).toBe('keys');
    }
    expect(keyToAction({ code: 'Slash' }, 'library')).toBe('searchFocus');
  });

  it('works with the Russian layout (physical key codes)', () => {
    // With the Russian layout the M key produces "ь", but event.code stays "KeyM".
    expect(keyToAction({ code: 'KeyM' }, 'amp')).toBe('mute');
    expect(keyToAction({ code: 'KeyI' }, 'song')).toBe('toggleInput');
    expect(keyToAction({ code: 'KeyT' }, 'library')).toBe('toggleTuner');
  });

  it('selects presets from the top row and the numpad on every screen', () => {
    for (const view of views) {
      expect(keyToAction({ code: 'Digit1' }, view)).toBe('preset1');
      expect(keyToAction({ code: 'Numpad4' }, view)).toBe('preset4');
    }
  });

  it('flips presets with the pedal keys on every screen', () => {
    for (const view of views) {
      expect(keyToAction({ code: 'PageDown' }, view)).toBe('presetNext');
      expect(keyToAction({ code: 'PageUp' }, view)).toBe('presetPrev');
    }
  });

  it('uses the arrows for seeking on the song screen and for presets on the amp screen', () => {
    expect(keyToAction({ code: 'ArrowRight' }, 'song')).toBe('seekFwd');
    expect(keyToAction({ code: 'ArrowLeft' }, 'song')).toBe('seekBack');
    expect(keyToAction({ code: 'ArrowRight' }, 'amp')).toBe('presetNext');
    expect(keyToAction({ code: 'ArrowLeft' }, 'input')).toBe('presetPrev');
  });

  it('keeps space as the main key', () => {
    for (const view of views) expect(keyToAction({ code: 'Space' }, view)).toBe('primary');
  });

  it('listens for the strums of «Подстроить под мою гитару» with G (П) on «Вход» only', () => {
    expect(keyToAction({ code: 'KeyG' }, 'input')).toBe('trimListen');
    expect(keyToAction({ code: 'KeyG' }, 'song')).toBe('guitarToggle');
    expect(keyToAction({ code: 'KeyG' }, 'amp')).toBeNull();
  });

  it('has the song keys on the song screen only', () => {
    expect(keyToAction({ code: 'KeyA' }, 'song')).toBe('loopA');
    expect(keyToAction({ code: 'KeyB' }, 'song')).toBe('loopB');
    expect(keyToAction({ code: 'KeyR' }, 'song')).toBe('loopToggle');
    expect(keyToAction({ code: 'Minus' }, 'song')).toBe('slower');
    expect(keyToAction({ code: 'Equal' }, 'song')).toBe('faster');
    expect(keyToAction({ code: 'Comma' }, 'song')).toBe('pitchDown');
    expect(keyToAction({ code: 'Period' }, 'song')).toBe('pitchUp');
    expect(keyToAction({ code: 'KeyG' }, 'song')).toBe('guitarToggle');
    expect(keyToAction({ code: 'KeyS' }, 'song')).toBe('guitarSolo');
    expect(keyToAction({ code: 'KeyZ' }, 'song')).toBe('bookmarkAdd');
    expect(keyToAction({ code: 'KeyX' }, 'song')).toBe('bookmarkNext');
    expect(keyToAction({ code: 'KeyE' }, 'song')).toBe('exportBacking');
    expect(keyToAction({ code: 'KeyN' }, 'song')).toBe('nextModel');
    expect(keyToAction({ code: 'Home' }, 'song')).toBe('home');
    expect(keyToAction({ code: 'KeyG' }, 'amp')).toBeNull();
  });

  it('uses Shift for the fine steps and the song volume', () => {
    expect(keyToAction({ code: 'Comma', shiftKey: true }, 'song')).toBe('centsDown');
    expect(keyToAction({ code: 'Period', shiftKey: true }, 'song')).toBe('centsUp');
    expect(keyToAction({ code: 'ArrowUp', shiftKey: true }, 'amp')).toBe('songVolUp');
    expect(keyToAction({ code: 'ArrowDown', shiftKey: true }, 'song')).toBe('songVolDown');
    expect(keyToAction({ code: 'ArrowUp' }, 'song')).toBe('volUp');
    expect(keyToAction({ code: 'KeyA', shiftKey: true }, 'song')).toBe('loopA');
  });

  it('turns the guitar alone with Alt+arrows on every screen', () => {
    expect(keyToAction({ code: 'ArrowUp', altKey: true }, 'song')).toBe('guitarVolUp');
    expect(keyToAction({ code: 'ArrowDown', altKey: true }, 'library')).toBe('guitarVolDown');
    expect(keyToAction({ code: 'ArrowUp', altKey: true, shiftKey: true }, 'song')).toBeNull();
    expect(keyToAction({ code: 'ArrowLeft', altKey: true }, 'song')).toBeNull(); // the browser's «back»
  });

  it('moves through the list on the library screen', () => {
    expect(keyToAction({ code: 'ArrowDown' }, 'library')).toBe('listDown');
    expect(keyToAction({ code: 'ArrowUp' }, 'library')).toBe('listUp');
    expect(keyToAction({ code: 'Delete' }, 'library')).toBe('deleteSong');
    expect(keyToAction({ code: 'Enter' }, 'library')).toBe('confirm');
  });

  it('switches screens from anywhere', () => {
    for (const view of views) {
      expect(keyToAction({ code: 'KeyL' }, view)).toBe('toggleLibrary');
      expect(keyToAction({ code: 'KeyK' }, view)).toBe('toggleAmp');
      expect(keyToAction({ code: 'Escape' }, view)).toBe('back');
    }
  });

  it('leaves browser shortcuts alone', () => {
    expect(keyToAction({ code: 'KeyM', ctrlKey: true }, 'amp')).toBeNull();
    expect(keyToAction({ code: 'KeyI', metaKey: true }, 'song')).toBeNull();
    expect(keyToAction({ code: 'Digit1', altKey: true }, 'song')).toBeNull();
  });

  it('ignores unmapped keys', () => {
    expect(keyToAction({ code: 'Insert' }, 'song')).toBeNull();
  });

  it('records on every screen with \\ (the key above Enter)', () => {
    for (const view of ['song', 'library', 'amp', 'input'] as const) {
      expect(keyToAction({ code: 'Backslash' }, view)).toBe('recordToggle');
    }
    expect(keyToAction({ code: 'IntlBackslash' }, 'song')).toBe('recordToggle');
  });

  it('has the stage-3 keys on the song screen only (Russian layout: Ц, Ж, Э, Ё)', () => {
    expect(keyToAction({ code: 'KeyW' }, 'song')).toBe('viewNext');
    expect(keyToAction({ code: 'Semicolon' }, 'song')).toBe('anchorHere');
    expect(keyToAction({ code: 'Semicolon', shiftKey: true }, 'song')).toBe('anchorClear');
    expect(keyToAction({ code: 'Quote' }, 'song')).toBe('tabTrackNext');
    expect(keyToAction({ code: 'Quote', shiftKey: true }, 'song')).toBe('tabNotation');
    expect(keyToAction({ code: 'Backquote' }, 'song')).toBe('stage');
    for (const code of ['Semicolon', 'Quote', 'Backquote']) {
      expect(keyToAction({ code }, 'library')).toBeNull();
      expect(keyToAction({ code }, 'amp')).toBeNull();
    }
    expect(keyToAction({ code: 'KeyW' }, 'amp')).toBeNull();
    expect(keyToAction({ code: 'KeyT' }, 'song')).toBe('toggleTuner'); // T stays the big tuner
  });

  it('has the stage-4 keys', () => {
    expect(keyToAction({ code: 'KeyR', shiftKey: true }, 'song')).toBe('repeatToggle');
    expect(keyToAction({ code: 'KeyR' }, 'song')).toBe('loopToggle');
    expect(keyToAction({ code: 'Equal', shiftKey: true }, 'song')).toBe('speedTrainer');
    expect(keyToAction({ code: 'KeyL', shiftKey: true }, 'amp')).toBe('randomSong'); // anywhere
    expect(keyToAction({ code: 'End' }, 'song')).toBe('queueNext');
    // «Песни»: lists, the set-list, the radio, the search
    expect(keyToAction({ code: 'KeyF' }, 'library')).toBe('favoriteToggle');
    expect(keyToAction({ code: 'KeyW' }, 'library')).toBe('learnToggle');
    expect(keyToAction({ code: 'KeyS' }, 'library')).toBe('setToggle');
    expect(keyToAction({ code: 'KeyR' }, 'library')).toBe('radio');
    expect(keyToAction({ code: 'Slash' }, 'library')).toBe('searchFocus');
    expect(keyToAction({ code: 'ArrowLeft' }, 'library')).toBe('libraryTabPrev');
    expect(keyToAction({ code: 'ArrowUp', shiftKey: true }, 'library')).toBe('setUp');
    expect(keyToAction({ code: 'ArrowUp', shiftKey: true }, 'song')).toBe('songVolUp'); // unchanged elsewhere
    expect(keyToAction({ code: 'KeyF' }, 'song')).toBe('fretView');
  });

  it('has the stage-2 keys on the song screen only', () => {
    const song: Record<string, string> = {
      KeyH: 'modeToggle',
      KeyJ: 'hintNext',
      KeyC: 'clickToggle',
      KeyO: 'countInToggle',
      KeyP: 'simpleToggle',
      BracketLeft: 'capoDown',
      BracketRight: 'capoUp',
      KeyU: 'tuningNext',
      KeyF: 'fretView',
      KeyD: 'degreesToggle',
      KeyV: 'voicingNext',
      KeyY: 'toneMatchToggle',
      KeyQ: 'loopSection',
    };
    for (const [code, action] of Object.entries(song)) {
      expect(keyToAction({ code }, 'song')).toBe(action);
      expect(keyToAction({ code }, 'amp')).toBeNull();
    }
  });

  it('uses Shift for hiding the hints, moving the bar lines and jumping between sections', () => {
    expect(keyToAction({ code: 'KeyH', shiftKey: true }, 'song')).toBe('hintsHide');
    expect(keyToAction({ code: 'BracketLeft', shiftKey: true }, 'song')).toBe('barShiftBack');
    expect(keyToAction({ code: 'BracketRight', shiftKey: true }, 'song')).toBe('barShiftFwd');
    expect(keyToAction({ code: 'ArrowLeft', shiftKey: true }, 'song')).toBe('sectionPrev');
    expect(keyToAction({ code: 'ArrowRight', shiftKey: true }, 'song')).toBe('sectionNext');
    expect(keyToAction({ code: 'ArrowRight', shiftKey: true }, 'amp')).toBe('presetNext');
  });

  it('shows the neck with F and steps what it shows with Shift+F', () => {
    expect(keyToAction({ code: 'KeyF' }, 'song')).toBe('fretView');
    expect(keyToAction({ code: 'KeyF', shiftKey: true }, 'song')).toBe('neckView');
  });
});
