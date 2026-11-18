// What the keys and buttons of «Песни» → «Записи» do.
import { getLanguage, L } from '../i18n';
import { api } from '../song/api';
import { useRuntime } from '../state/runtime';
import { useSong } from '../state/song';
import { refreshTakes, useTakes } from '../state/takes';

const toast = (text: string, tone: 'info' | 'warn' = 'info') => useRuntime.getState().showToast(text, tone);
const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/** «Гитара раньше / позже» moves by this much a press. */
export const NUDGE_MS = 10;
const MAX_OFFSET_MS = 500;

let pendingDelete: { id: string; until: number } | null = null;

/** «15 ноября, 18:30» / “November 15, 06:30 PM” in local time, in the interface's language. */
export function takeWhen(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  const locale = getLanguage() === 'ru' ? 'ru-RU' : 'en-US';
  const day = date.toLocaleDateString(locale, { day: 'numeric', month: 'long' });
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

export const takeActions = {
  /** ↑ / ↓ in «Записи». */
  move(dir: 1 | -1): void {
    const { takes, selectedTakeId, patch } = useTakes.getState();
    if (!takes.length) return;
    const index = takes.findIndex((t) => t.id === selectedTakeId);
    patch({ selectedTakeId: takes[Math.min(takes.length - 1, Math.max(0, index + dir))]!.id });
  },

  select(id: string): void {
    useTakes.getState().patch({ selectedTakeId: id });
  },

  /** Enter and «Слушать»: the highlighted take plays or stops. The song pauses for it. */
  togglePlay(id = useTakes.getState().selectedTakeId): void {
    if (!id) return;
    const { playingTakeId, patch } = useTakes.getState();
    if (playingTakeId === id) {
      patch({ playingTakeId: null });
      return;
    }
    if (useSong.getState().playing) useSong.getState().patch({ playing: false });
    patch({ playingTakeId: id, selectedTakeId: id });
  },

  stopPlaying(): void {
    if (useTakes.getState().playingTakeId) useTakes.getState().patch({ playingTakeId: null });
  },

  /** «Гитара раньше / позже»: the service builds the mp3 again. */
  async nudge(id: string, deltaMs: number): Promise<void> {
    const take = useTakes.getState().takes.find((t) => t.id === id);
    if (!take) return;
    const offset = Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, take.guitarOffsetMs + deltaMs));
    if (offset === take.guitarOffsetMs) return;
    try {
      const fresh = await api.patchTake(id, offset);
      const { takes, versions, patch } = useTakes.getState();
      patch({
        takes: takes.map((t) => (t.id === id ? fresh : t)),
        versions: { ...versions, [id]: (versions[id] ?? 0) + 1 },
      });
    } catch (error) {
      toast(messageOf(error, L().actions.record.nudgeFailed), 'warn');
    }
  },

  /** The mp3 into the browser's downloads. */
  download(id: string): void {
    const link = document.createElement('a');
    link.href = api.takeDownloadUrl(id);
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
  },

  /** Delete, Delete (or «Удалить» twice). */
  async deleteTwice(id = useTakes.getState().selectedTakeId): Promise<void> {
    const take = useTakes.getState().takes.find((t) => t.id === id);
    if (!take) return;
    const now = Date.now();
    if (!pendingDelete || pendingDelete.id !== take.id || pendingDelete.until < now) {
      pendingDelete = { id: take.id, until: now + 4000 };
      toast(L().actions.record.deleteAgain(take.title, takeWhen(take.createdAt)), 'warn');
      return;
    }
    pendingDelete = null;
    try {
      if (useTakes.getState().playingTakeId === take.id) useTakes.getState().patch({ playingTakeId: null });
      await api.deleteTake(take.id);
      await refreshTakes();
      toast(L().actions.record.deleted);
    } catch (error) {
      toast(messageOf(error, L().actions.record.deleteFailed), 'warn');
    }
  },
};
