import { memo } from 'react';
import type { Bar } from '../music/bars';

/** The bar lines with their numbers under a lane («Ноты»); drawn once per song, bar shift or lane width. */
export const LaneBars = memo(function LaneBars({ bars, pps }: { bars: Bar[]; pps: number }) {
  return (
    <>
      {bars.map((bar) => (
        <span key={`b${bar.start}`} className="lane__bar" style={{ left: `${bar.start * pps}px` }}>
          {bar.number > 0 && (bar.number === 1 || bar.number % 4 === 1) ? bar.number : ''}
        </span>
      ))}
    </>
  );
});
