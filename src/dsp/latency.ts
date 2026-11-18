// "String hit → sound" latency estimate from what the browser reports.

export interface LatencyEstimate {
  inputMs: number;
  processingMs: number;
  outputMs: number;
  totalMs: number;
  /** True when the browser did not report input latency and we assumed it. */
  inputEstimated: boolean;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function estimateLatency(p: {
  baseLatency: number;
  outputLatency: number;
  inputLatency?: number | null;
}): LatencyEstimate {
  const inputEstimated = !(typeof p.inputLatency === 'number' && p.inputLatency > 0);
  const inputMs = round1((inputEstimated ? p.baseLatency : (p.inputLatency as number)) * 1000);
  const processingMs = round1(p.baseLatency * 1000);
  const outputMs = round1(Math.max(0, p.outputLatency) * 1000);
  return { inputMs, processingMs, outputMs, totalMs: round1(inputMs + processingMs + outputMs), inputEstimated };
}

export type LatencyRating = 'great' | 'ok' | 'bad';

export function rateLatency(totalMs: number): LatencyRating {
  if (totalMs <= 12) return 'great';
  if (totalMs <= 20) return 'ok';
  return 'bad';
}

/**
 * The M-Track's driver sometimes gets stuck holding about 10 ms more on its input (measured
 * 2026-11-13: 16.5 ms at buffer 128 instead of 6.1; the same +10.4 at 64 and 32) until the USB cable
 * is pulled out and back in. Healthy, its input is the buffer plus 3.5–4.5 ms.
 */
export const DRIVER_STUCK_EXTRA_MS = 8;

/**
 * True when an M-Track's input latency is far over its buffer (frames at `sampleRate`): its driver
 * is stuck. Only the M-Track: other drivers keep a big safety buffer as a rule (ASIO4ALL, generic USB).
 */
export function driverStuck(device: string | null, latency: LatencyEstimate, buffer: number, sampleRate: number): boolean {
  if (!device?.toLowerCase().includes('m-track')) return false;
  return latency.inputMs - (buffer / sampleRate) * 1000 > DRIVER_STUCK_EXTRA_MS;
}
