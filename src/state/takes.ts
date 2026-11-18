// «Запись»: the takes on the service, the one being recorded and the one being listened to.
import { create } from 'zustand';
import { api, ServiceError } from '../song/api';
import type { Take } from '../song/types';

export interface Recording {
  id: string;
  /** performance.now() at the start: the top bar counts from it. */
  startedAt: number;
}

interface TakesData {
  takes: Take[];
  /** Highlighted take in «Песни» → «Записи». */
  selectedTakeId: string | null;
  /** The take being listened to (its card's player is playing). */
  playingTakeId: string | null;
  recording: Recording | null;
  /** The recording has stopped and the service is building its files. */
  saving: boolean;
  /** Bumped when a take's mp3 is built again, so the player loads the new one. */
  versions: Record<string, number>;
}

export const useTakes = create<TakesData & { patch(p: Partial<TakesData>): void }>()((set) => ({
  takes: [],
  selectedTakeId: null,
  playingTakeId: null,
  recording: null,
  saving: false,
  versions: {},
  patch: (p) => set(p),
}));

/** Fetches the list of takes; `select` highlights that take. */
export async function refreshTakes(select?: string): Promise<void> {
  try {
    const takes = (await api.listTakes()).filter((t) => t.status === 'ready');
    const wanted = select ?? useTakes.getState().selectedTakeId;
    useTakes.setState({
      takes,
      selectedTakeId: takes.some((t) => t.id === wanted) ? wanted : (takes[0]?.id ?? null),
    });
  } catch (error) {
    if (!(error instanceof ServiceError && error.offline)) console.warn('[takes] refresh failed', error);
  }
}
