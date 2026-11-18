import type { Dict } from '../dict';

type P = Record<string, string | number>;

const rules = new Intl.PluralRules('ru');

/** A limit sent in seconds, after «длиннее» or «не больше»: «12 минут», «1 минуты», «45 секунд». */
const span = (seconds: string | number | undefined): string => {
  const s = Number(seconds) || 0;
  const n = s >= 60 ? Math.round(s / 60) : Math.round(s);
  const one = rules.select(n) === 'one';
  return s >= 60 ? `${n} ${one ? 'минуты' : 'минут'}` : `${n} ${one ? 'секунды' : 'секунд'}`;
};

const khz = (hz: string | number | undefined): string => `${String((Number(hz) || 0) / 1000).replace('.', ',')} кГц`;

export const service: Dict['service'] = {
  unknown: (code: string) => `Что-то пошло не так (${code}).`,
  offline: 'Песни недоступны. Перезапусти Strum.',
  requestFailed: (p: P) => `С песнями не получилось (ошибка ${p.status}).`,

  'program.filesMissing': 'Не хватает файлов программы. Переустанови Strum.',
  'origin.forbidden': 'Этот адрес только для Strum.',

  // Песни
  'song.notFound': 'Песня не найдена.',
  'song.tooLong': (p: P) => `Песня длиннее ${span(p.limit)}. Такие пока не поддерживаются.`,
  'audio.wrongRate': (p: P) => `Нужен звук ${khz(p.want)}, а пришёл ${khz(p.rate)}.`,
  'audio.notStereo': (p: P) => `Нужен стереозвук (2 канала), а пришло каналов: ${p.channels}.`,
  'audio.notFloat': 'Звук песни пришёл не в том формате.',
  'audio.unreadable': 'Не удалось прочитать звук песни.',

  // Дорожки, такты и аккорды, слова
  'stems.notReady': 'Эти дорожки ещё не готовы.',
  'stems.missing': 'Таких дорожек нет.',
  'separation.failed': (p: P) => `Не удалось разделить песню (${p.reason}).`,
  'separation.cpuNoGpu': 'Видеокарта NVIDIA не найдена, поэтому разделение шло на процессоре (дольше).',
  'separation.smallerChunks': 'Видеокарте не хватило памяти, поэтому песня делилась кусками поменьше.',
  'separation.cpuNoVram': 'Видеокарте не хватило памяти, поэтому разделение шло на процессоре (дольше).',
  'separation.cpuGpuFailed': 'На видеокарте разделить не получилось, поэтому оно шло на процессоре (дольше).',
  'analysis.none': 'Тактов и аккордов пока нет.',
  'analysis.failed': (p: P) => `Не удалось найти такты и аккорды (${p.reason}).`,
  'analysis.noMusic': 'Не нашлось ни долей, ни аккордов. Похоже, тут нет музыки.',
  'analysis.crashedTwice': 'Поиск тактов и аккордов дважды прервался на этой песне. Запусти его снова в карточке песни.',
  'words.none': 'Слов пока нет.',
  'words.failed': (p: P) => `Не удалось распознать слова (${p.reason}).`,
  'words.crashedTwice': 'Распознавание слов дважды прервалось на этой песне. Запусти его снова в правке текста.',
  'transcript.needsStems': 'Сначала раздели песню на дорожки.',

  // Табы и песни из таба
  'tab.none': 'У песни нет таба.',
  'tab.notATab': 'Это не файл таба.',
  'tab.empty': 'Файл таба пустой.',
  'tab.tooBig': (p: P) => `Файл таба больше ${p.limit} МБ. Это точно таб?`,
  'tab.tooLong': (p: P) => `Таб длиннее ${span(p.limit)}. Такие пока не поддерживаются.`,
  'tab.keyUnreadable': 'Не удалось прочитать тональность таба.',
  'tabSong.nothingToSeparate': 'У песни из таба нет записи: делить и слушать нечего.',
  'tabSong.noExport': 'Минусовку из песни-таба пока не сделать.',
  'tabSong.noAudio': 'У песни из таба нет своего звука: Strum играет её по табу.',
  'tabSong.tabIsTheSong': 'Это песня из таба. Другой таб станет новой песней.',

  // Минусовка
  'export.stemsNotReady': 'Дорожки ещё не готовы. Минусовка появится, когда песня разделится.',
  'export.tooShort': 'Слишком короткий кусок для минусовки.',

  // Записи
  'take.none': 'Запись не найдена.',
  'take.chunkTooBig': 'Кусок записи слишком большой.',
  'take.chunkBroken': 'Кусок записи пришёл битым.',
  'take.tooShort': 'Запись короче секунды и не сохранилась.',
  'take.tooLong': (p: P) => `Запись может длиться не больше ${span(p.limit)}.`,
  'take.notRecording': 'Эта запись уже закончена.',
  'take.rateChanged': 'Частота звука поменялась посреди записи.',
  'take.broken': (p: P) => `Запись не сохранилась (${p.reason}).`,

  // Звук гитары через ASIO
  'guitar.rate':
    'Звуковая карта не открылась на 48 000 Гц. Поставь 48 000 Гц в панели карты и в настройках звука Windows.',
  'guitar.deviceLost': 'Звуковая карта пропала. Проверь USB-кабель.',
  'guitar.noDevices': 'Звуковая карта не найдена. Подключи карту и проверь, что её драйвер ASIO установлен.',
  'guitar.deviceNotFound': (p: P) =>
    `Звуковая карта «${p.name}» не найдена. Проверь, что она подключена, или выбери другую.`,
  'guitar.openFailed': (p: P) =>
    `Звуковая карта не открылась (${p.reason}). Закрой программы, которые её заняли, и попробуй снова.`,
  'guitar.chainBroke': (p: P) => `Звук гитары через ASIO сломался (${p.reason}).`,
  'guitar.processDied': 'Звук гитары через ASIO остановился. Он сам запустится заново через несколько секунд.',
  'guitar.processFailed': (p: P) => `Звук гитары через ASIO не запустился (${p.reason}).`,

  // Файлы усилителя, кабинета и ревера
  'amp.modelFailed': (p: P) => `Модель усилителя не загрузилась (${p.reason}). Играет простой усилитель.`,
  'amp.engineFailed': (p: P) => `Усилитель не запустился (${p.reason}). Играет простой усилитель.`,
  'amp.cabFailed': (p: P) => `Кабинет не загрузился (${p.reason}).`,
  'amp.reverbFailed': (p: P) => `Ревер не загрузился (${p.reason}).`,
  'amp.userModelGone': 'Своя модель усилителя не найдена. Перетащи файл .nam ещё раз.',
  'amp.userIrGone': 'Свой кабинет не найден. Перетащи файл .wav ещё раз.',
  'amp.unknownBuiltIn': (p: P) => `Неизвестный встроенный звук: ${p.id}.`,
  'amp.irUnreadable': 'Не удалось прочитать кабинет: нужен файл WAV.',
  'amp.irSilent': 'В этом файле WAV нет звука.',

  // Настройки и свои файлы комбиков рядом с песнями
  'settings.none': 'Настройки ещё не сохранялись.',
  'settings.tooBig': 'Настройки слишком большие, их не сохранить.',
  'settings.bad': 'Не удалось прочитать настройки.',
  'asset.none': 'Файл комбика не найден.',
  'asset.bad': 'Файл комбика не сохранился.',
  'asset.tooBig': 'Файл слишком большой для комбика или кабинета.',

  // Загрузка разделения песен и слов вокала (установленная программа)
  'components.failed': (p: P) => `Загрузка прервалась (${p.reason}).`,
};
