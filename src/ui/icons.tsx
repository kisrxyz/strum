// The icons lucide has no drawing for, made the same way (24 px grid, round 2 px line), so they
// take the same size and line width as the rest (`LucideProvider` in App.tsx sets both).
import { createLucideIcon } from 'lucide-react';

/** A combo amp: the control strip on top, the speaker under it. */
export const IconAmp = createLucideIcon('amp', [
  ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2', key: 'body' }],
  ['path', { d: 'M3 9h18', key: 'strip' }],
  ['path', { d: 'M7 6.5h.01', key: 'k1' }],
  ['path', { d: 'M10.5 6.5h.01', key: 'k2' }],
  ['path', { d: 'M14 6.5h.01', key: 'k3' }],
  ['circle', { cx: '12', cy: '14.5', r: '3', key: 'speaker' }],
]);

/** A tuning fork. */
export const IconTuner = createLucideIcon('tuner', [
  ['path', { d: 'M8.5 3v6.5a3.5 3.5 0 0 0 7 0V3', key: 'prongs' }],
  ['path', { d: 'M12 13v8', key: 'stem' }],
]);

/** A piece of the neck: frets and two inlays. */
export const IconNeck = createLucideIcon('neck', [
  ['rect', { x: '2', y: '7', width: '20', height: '10', rx: '1.5', key: 'board' }],
  ['path', { d: 'M7 7v10', key: 'f1' }],
  ['path', { d: 'M12 7v10', key: 'f2' }],
  ['path', { d: 'M17 7v10', key: 'f3' }],
  ['path', { d: 'M9.5 12h.01', key: 'd1' }],
  ['path', { d: 'M14.5 12h.01', key: 'd2' }],
]);

/** Record: a ring with a solid dot. */
export const IconRecord = createLucideIcon('record', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'ring' }],
  ['circle', { cx: '12', cy: '12', r: '3.5', fill: 'currentColor', key: 'dot' }],
]);

/** Stop recording: a ring with a solid square. */
export const IconRecordStop = createLucideIcon('record-stop', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'ring' }],
  ['rect', { x: '9', y: '9', width: '6', height: '6', rx: '1', fill: 'currentColor', key: 'square' }],
]);
