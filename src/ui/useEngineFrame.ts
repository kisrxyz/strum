import { useEffect, useEffectEvent } from 'react';
import { engine, type InputSnapshot } from '../audio/engine';

/**
 * Calls `onFrame` every animation frame with the latest meter / tuner reading and the frame's
 * time. Pass that time to `songPlayer.position(now)`: every part of the screen then shows the
 * same song moment, and the moving parts step evenly from frame to frame.
 */
export function useEngineFrame(onFrame: (snapshot: InputSnapshot, now: number) => void): void {
  const handle = useEffectEvent(onFrame);
  useEffect(() => engine.onFrame((s, now) => handle(s, now)), []);
}
