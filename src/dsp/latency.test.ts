import { describe, expect, it } from 'vitest';
import { driverStuck, estimateLatency, rateLatency, type LatencyEstimate } from './latency';

describe('latency', () => {
  it('assumes input latency equals the processing buffer when the browser does not report it', () => {
    const est = estimateLatency({ baseLatency: 0.01, outputLatency: 0.004, inputLatency: null });
    expect(est).toEqual({ inputMs: 10, processingMs: 10, outputMs: 4, totalMs: 24, inputEstimated: true });
  });

  it('uses the reported input latency', () => {
    const est = estimateLatency({ baseLatency: 0.005, outputLatency: 0.003, inputLatency: 0.002 });
    expect(est.totalMs).toBe(10);
    expect(est.inputEstimated).toBe(false);
  });

  it('rates latency the way it feels', () => {
    expect(rateLatency(11)).toBe('great');
    expect(rateLatency(16)).toBe('ok');
    expect(rateLatency(25)).toBe('bad');
  });
});

describe('a stuck card driver', () => {
  const native = (inputMs: number, outputMs: number): LatencyEstimate => ({
    inputMs, processingMs: 0, outputMs, totalMs: inputMs + outputMs, inputEstimated: false,
  });
  it('is far over the buffer, a healthy M-Track is not (measured 2026-11-13)', () => {
    expect(driverStuck('M-Track Solo and Duo ASIO', native(16.5, 5), 128, 48000)).toBe(true);
    expect(driverStuck('M-Track Solo and Duo ASIO', native(15.2, 3.7), 64, 48000)).toBe(true);
    expect(driverStuck('M-Track Solo and Duo ASIO', native(14.5, 3), 32, 48000)).toBe(true);
    expect(driverStuck('M-Track Solo and Duo ASIO', native(7.1, 5), 128, 48000)).toBe(false);
    expect(driverStuck('M-Track Solo and Duo ASIO', native(6.1, 5), 128, 48000)).toBe(false);
    expect(driverStuck('M-Track Solo and Duo ASIO', native(4.8, 3.7), 64, 48000)).toBe(false);
  });

  it('says nothing about other cards: a big safety buffer is how their drivers work', () => {
    expect(driverStuck('ASIO4ALL v2', native(16.5, 5), 128, 48000)).toBe(false);
    expect(driverStuck('UMC ASIO Driver', native(20, 8), 128, 48000)).toBe(false);
    expect(driverStuck(null, native(16.5, 5), 128, 48000)).toBe(false);
  });
});
