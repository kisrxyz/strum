// What «Вход», the latency badge and the start screen say about the guitar's path: the native
// engine («Быстрый», ASIO) or the browser's own chain. Plain text and rules, no DOM, so they are
// tested without a screen.
import type { EngineBuffer } from '../audio/native/protocol';
import type { LatencyEstimate, LatencyRating } from '../dsp/latency';
import { getLanguage, L } from '../i18n';
import type { GuitarPath, NativeLinkStatus } from '../state/runtime';
import type { GuitarEngine } from '../state/settings';

/** The native engine runs at 48 kHz only (it reports an error for a card that will not). */
export const NATIVE_RATE = 48000;

/** One decimal (a comma in Russian), and no «.0»: 2.667 → «2.7» / «2,7», 8 → «8». */
export function fmtMs1(ms: number): string {
  const text = String(Math.round(ms * 10) / 10);
  return getLanguage() === 'ru' ? text.replace('.', ',') : text;
}

// ---- which controls «Вход» shows ----

export interface PickerLayout {
  /** Sound card, buffer, the latency line and the clicks line (the native engine's). */
  native: boolean;
  /** The browser's input and output pickers and the latency mode. */
  browser: boolean;
}

export function pickerLayout(choice: GuitarEngine): PickerLayout {
  return { native: choice === 'native', browser: choice === 'browser' };
}

// ---- the native engine's pickers ----

/** How long one buffer lasts at 48 kHz, ms. */
export function bufferMs(frames: number): number {
  return (frames / NATIVE_RATE) * 1000;
}

/** «128 · ≈ 2.7 ms». */
export function bufferLabel(frames: number): string {
  return `${frames} · ≈ ${fmtMs1(bufferMs(frames))} ${L().common.units.ms}`;
}

export function bufferOptions(buffers: readonly EngineBuffer[]): { value: EngineBuffer; label: string }[] {
  return buffers.map((value) => ({ value, label: bufferLabel(value) }));
}

/** The engine's cards; the one chosen earlier stays in the list when the card is not there now. */
export function nativeDeviceNames(devices: readonly string[], chosen: string | null): string[] {
  return chosen !== null && !devices.includes(chosen) ? [...devices, chosen] : [...devices];
}

// ---- latency ----

/** The big readout and the badge: the native number has a decimal (it is a few ms), the browser's is whole. */
export function latencyTotalText(latency: LatencyEstimate, path: GuitarPath | null): string {
  return `≈ ${path === 'native' ? fmtMs1(latency.totalMs) : Math.round(latency.totalMs)} ${L().common.units.ms}`;
}

/** The native engine's driver latency, in one line (the engine adds no processing of its own). */
export function nativeLatencyLine(latency: LatencyEstimate): string {
  return L().input.latencyLine(fmtMs1(latency.totalMs), fmtMs1(latency.inputMs), fmtMs1(latency.outputMs));
}

/** On the native path the headphones are in the card already: only the buffer is left to change. */
export function latencyAdvice(rating: LatencyRating, path: GuitarPath | null): string {
  const t = L().input;
  return path === 'native' && rating !== 'great' ? t.nativeAdvice[rating] : t.advice[rating];
}

/** The small print under the latency card. */
export function latencySource(path: GuitarPath | null): string {
  return path === 'native' ? L().input.sourceNative : L().input.sourceSystem;
}

export function latencyBadgeTitle(path: GuitarPath | null): string {
  return path === 'native' ? L().input.badgeNative : L().input.badgeSystem;
}

// ---- clicks (xruns) ----

/**
 * The engine counts dropouts from some start; the screen counts from `baseline` (the count when
 * the card or the buffer was last changed here). A count that fell below the baseline means the
 * engine started counting again (the card was reopened): everything it counts is new.
 */
export function clicksSince(baseline: number, xruns: number): { baseline: number; clicks: number } {
  const from = xruns < baseline ? 0 : baseline;
  return { baseline: from, clicks: xruns - from };
}

export function canGrowBuffer(buffer: EngineBuffer, buffers: readonly EngineBuffer[]): boolean {
  return buffers.some((b) => b > buffer);
}

/** Null while nothing clicked. With the biggest buffer already, a bigger one is no advice. */
export function clicksLine(clicks: number, canGrow: boolean): string | null {
  if (clicks <= 0) return null;
  return canGrow ? L().input.clicksBigger(clicks) : L().input.clicksClose(clicks);
}

// ---- why the guitar is not on the path that was chosen ----

/** The toast's text when the guitar plays through another path than the one chosen; null otherwise. */
export function routeNote(choice: GuitarEngine, path: GuitarPath | null, note: string | null): string | null {
  return path !== null && path !== choice ? note : null;
}

// ---- the start screen ----

/**
 * The browser asks about the microphone only when it plays the guitar itself: in System audio, or
 * in ASIO once the engine was not reached (link 'lost') and the browser takes over.
 */
export function micHint(choice: GuitarEngine, link: NativeLinkStatus): string | null {
  return choice === 'browser' || link === 'lost' ? L().input.micHint : null;
}
