// Opening the guitar input and listing audio devices.
import { L } from '../i18n';
import type { DeviceOption, EngineErrorKind } from '../state/runtime';

export class EngineError extends Error {
  constructor(
    readonly kind: EngineErrorKind,
    detail?: string,
  ) {
    super(detail ?? kind);
  }
}

/** Raw guitar signal: the browser must not treat it as a voice call. */
function constraints(deviceId: string | null): MediaStreamConstraints {
  // `latency` is a standard audio constraint Chrome honours, missing from TypeScript's DOM types.
  const audio: MediaTrackConstraints & { latency?: ConstrainDouble } = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    latency: { ideal: 0 },
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

function toEngineError(error: unknown): EngineError {
  const name = error instanceof DOMException ? error.name : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (name === 'NotAllowedError' || name === 'SecurityError') return new EngineError('permission', detail);
  if (name === 'NotFoundError') return new EngineError('no-device', detail);
  if (name === 'NotReadableError' || name === 'AbortError') return new EngineError('busy', detail);
  return error instanceof EngineError ? error : new EngineError('other', detail);
}

/**
 * «Без входа — только песня»: no microphone is opened at all. Windows treats an open microphone as
 * a call: it turns other sounds down and its voice processing makes the song sound squashed.
 */
export const NO_INPUT = 'none';

/** Opens the saved device; if it is gone, falls back to the default one. Null for NO_INPUT. */
export async function openInput(deviceId: string | null): Promise<MediaStream | null> {
  if (deviceId === NO_INPUT) return null;
  if (!navigator.mediaDevices?.getUserMedia) throw new EngineError('unsupported');
  try {
    return await navigator.mediaDevices.getUserMedia(constraints(deviceId));
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints(null));
      } catch (fallbackError) {
        throw toEngineError(fallbackError);
      }
    }
    throw toEngineError(error);
  }
}

function label(device: MediaDeviceInfo, index: number): string {
  const raw = device.label || L().input.deviceN(index + 1);
  return raw.replace(/^Default - /, L().input.defaultDevice);
}

export async function listDevices(): Promise<{ inputs: DeviceOption[]; outputs: DeviceOption[] }> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  // Windows lists every device again as "communications"; that entry is a duplicate.
  const usable = devices.filter((d) => d.deviceId && d.deviceId !== 'communications');
  const pick = (kind: MediaDeviceKind) =>
    usable.filter((d) => d.kind === kind).map((d, i) => ({ id: d.deviceId, label: label(d, i) }));
  return { inputs: pick('audioinput'), outputs: pick('audiooutput') };
}
