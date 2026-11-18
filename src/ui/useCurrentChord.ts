import { useRef, useState } from 'react';
import { nextNote, noteAt } from '../music/notes';
import { chordAt } from '../music/track';
import { songPlayer } from '../song/player';
import type { ChordSegment, GuitarNote } from '../song/types';
import { useSong } from '../state/song';
import { useEngineFrame } from './useEngineFrame';

/** Index of the chord segment at the playhead (−1 before the first); re-renders only on a change. */
export function useCurrentChord(track: ChordSegment[]): number {
  const [index, setIndex] = useState(-1);
  const last = useRef(-1);
  useEngineFrame((_, now) => {
    const pos = useSong.getState().state === 'ready' ? songPlayer.position(now) : 0;
    const i = chordAt(track, pos);
    if (i !== last.current) {
      last.current = i;
      setIndex(i);
    }
  });
  return index;
}

/** «Ноты»: the note sounding at the playhead and the next one (indexes, −1: none); re-renders only on a change. */
export function useCurrentNote(notes: GuitarNote[]): { now: number; next: number } {
  const [state, setState] = useState({ now: -1, next: -1 });
  const last = useRef(state);
  useEngineFrame((_, now) => {
    const pos = useSong.getState().state === 'ready' ? songPlayer.position(now) : 0;
    const i = noteAt(notes, pos);
    const n = nextNote(notes, pos);
    if (i !== last.current.now || n !== last.current.next) {
      last.current = { now: i, next: n };
      setState(last.current);
    }
  });
  return state;
}
