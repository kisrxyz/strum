import type { Dict } from '../dict';

export const shell: Dict['shell'] = {
  screens: { song: 'Песня', library: 'Песни', amp: 'Комбик', input: 'Вход' },
  screensLabel: 'Экраны',
  presets: 'Пресеты',
  setlistPlace: (place: number, total: number) => `Сет-лист ${place} из ${total}`,
  radio: 'Радио',
  record: 'Запись',
  recordStart: 'Записать свою игру и песню, как ты их слышишь',
  recordStop: 'Остановить и сохранить запись',
  tuner: 'Тюнер',
  guitarMuted: 'Гитара выключена',

  start: {
    label: 'Запуск звука',
    starting: 'Запуск звука…',
    pressBefore: 'Нажми',
    space: 'пробел',
    pressAfter: ', чтобы играть',
    errors: {
      permission: 'Нет доступа ко входу. Нажми на значок слева от адреса, затем Микрофон → Разрешить, потом Попробовать снова.',
      noDevice: 'Вход не найден. Подключи гитарный кабель или звуковую карту и нажми Попробовать снова.',
      busy: 'Вход занят другой программой, например звонком или DAW. Закрой её и нажми Попробовать снова.',
      unsupported: (app: string) => `Этот браузер не может играть звук гитары. Открой ${app} в Google Chrome.`,
      other: 'Звук не запустился.',
    },
  },

  bigTuner: 'Большой тюнер',
  bigTunerClose: 'Закрыть: T или Esc',
  dropZone: 'Отпусти, чтобы добавить: песню (mp3, m4a, wav, flac), таб Guitar Pro, модель усилителя (.nam) или кабинет (.wav)',

  neckShape: 'Гриф: аппликатура аккорда.',
  neckChord: 'Гриф: все ноты аккорда.',
  neckScale: 'Гриф: весь лад, ноты аккорда крупно.',
  degreesOn: 'На грифе ступени: 1, ♭3, 5, ♭7.',
  degreesOff: 'На грифе названия нот.',
  modelAdded: (name: string) => `Модель «${name}» теперь в пресете.`,
  cabinetAdded: (name: string) => `Кабинет «${name}» теперь в пресете.`,
  fileRejected: 'Файл не подошёл.',
  dropUnknown: (name: string) => `«${name}»: это не песня, не таб, не текст, не модель усилителя и не кабинет.`,

  about: {
    open: (app: string) => `О программе ${app}`,
    version: (v: string) => `Версия ${v}`,
    free: 'Свободная программа под лицензией GNU GPL версии 3. Её можно использовать, раздавать и менять.',
    local: 'Всё работает на этом компьютере: песни и записи никуда не отправляются.',
    builtOn: 'На чём сделана',
    gpl: 'GNU General Public License, версия 3',
    closeHint: 'Закрыть: Esc',
  },
};
