import type { Dict } from '../dict';

export const common: Dict['common'] = {
  ok: 'ОК',
  done: 'Готово',
  cancel: 'Отмена',
  close: 'Закрыть',
  delete: 'Удалить',
  retry: 'Попробовать снова',
  reset: 'Сбросить',
  on: 'вкл',
  off: 'выкл',
  none: 'нет',
  loading: 'Загрузка…',
  saving: 'Сохранение…',
  pressAgainToDelete: 'Нажми ещё раз, чтобы удалить.',
  units: {
    db: 'дБ',
    ms: 'мс',
    hz: 'Гц',
    khz: 'кГц',
    s: 'с',
    pct: (n: number) => `${n} %`,
  },
};
