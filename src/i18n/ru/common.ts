import type { Dict } from '../dict';

export const common: Dict['common'] = {
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
  units: {
    db: 'дБ',
    ms: 'мс',
    hz: 'Гц',
    pct: (n: number) => `${n} %`,
  },
};
