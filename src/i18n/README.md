# Strum's words

All user-facing text lives here.
- `en/` is the source shape; English is the default language.
- `ru/` has exactly the same keys; `tsc` and `i18n.test.ts` check that.
- One file per namespace. A namespace belongs to a group of screens.

## How code uses it

- **Components:** `const t = useLang();` (from `src/i18n/useLang.ts`), then `t.amp.drive`. The component re-renders when the language changes.
- **Plain code** (actions, stores, engine glue): `L().actions.loopSet(from, to)` at the moment the text is built. Never store a translated text in module scope.
- **Parameters:** an entry with parameters is a function with typed arguments, e.g. `(name: string) => \`“${name}” added\``. Plurals use `plural(n, { one, few, many, other })` from `plural.ts` inside the function.
- **Messages from Python** (the song service, the guitar engine) are `{ code, params }`. `messageText()` from `messages.ts` turns them into words through the `service` namespace. A plain string (an old service) is shown as is.
- **Tooltips with a key:** `title={withKey(t.songUi.loop, 'R')}` → "Loop (R)".
- **A key chip `<kbd>`** stays only on the start screen (Space) and on a primary button that Enter triggers.

## Copy rules

Both languages follow these rules.

1. **No «я» / "I".** The app never speaks as «я» / "I". States are impersonal: "Separating 40%", «Разделение 40 %», "Loading…", «Загрузка…».
2. **Buttons.** A verb plus the thing it acts on, or a noun, 1–3 words: "Add song", «Добавить песню», "Loop", «Петля».
3. **Quotes.** No quotation marks around feature names. Quotes only around the user's own content: a song title, a file name. Russian uses «…», English uses “…”.
4. **Dashes.** At most one dash (—) per line. Prefer a colon or a full stop.
5. **Toasts.** A toast says only what happened. No key hints in toasts: keys live in tooltips and on the Keys sheet.
6. **No kitchen words.** Never in the UI: npm, terminal, «сервис» / "service", spec, uv, Vite, Chrome. «браузер» / "browser" is never the name of a sound path. No model names (Demucs, BS-RoFormer, Whisper, NAM, CREPE), no VRAM / «видеопамять», no LRCLIB.
   - Exception: the stem model switch, shown only when two models' stems exist.
   - Exception: the lyrics-search privacy note names lrclib.net.
   - Exception: About shows LICENSES.txt and the GPL as they are (English, every name).
7. **Address.** «ты» / "you". No exclamation marks, no emoji.
8. **Full stops.** Short labels and buttons have none. Sentences in hints and toasts have one.
9. **Values as numbers:** "Buffer 256", "48 000 Hz", "+6 dB".
10. **Minus sign.** Russian figures use the minus sign `−` (U+2212).
11. **Say it once and short.** A hint is one sentence about what the control does, not how it works inside: "Gate: silences the noise between notes." Recommended values come as numbers.
12. **English is written fresh,** not translated word by word. It should read like Songsterr or Guitar Pro: short, plain, sentence case.

## Glossary

Use the same word for the same thing everywhere.

| en | ru |
|---|---|
| Song / Songs (screens) | Песня / Песни |
| Amp (screen) | Комбик |
| Input (screen) | Вход |
| Tuner | Тюнер |
| Record / Takes | Запись / Записи |
| Lyrics · Chords · Tab · Notes (views) | Текст · Аккорды · Табы · Ноты |
| Stems / Separate into stems | Дорожки / Разделить на дорожки |
| Backing track (export) | Минусовка |
| Loop · Section · Phrase · Bookmark | Петля · Часть · Фраза · Закладка |
| Count-in · Click | Отсчёт · Клик |
| Speed · Pitch | Скорость · Тон |
| Capo · Tuning · Simple chords | Каподастр · Строй · Простые аккорды |
| Fretboard · Fingering · Scale | Гриф · Аппликатура · Лад |
| Play by ear · Hint | Снять на слух · Подсказка |
| Match song tone | Звук как в песне |
| Original guitar (on/off) | Гитара в записи (играет / молчит) |
| Guitar only | Только гитара |
| Repeat after me | Повтори за мной |
| Speed trainer | Разгон |
| Favorites · Learning · Set list · Radio · Random | Избранное · Учу · Сет-лист · Радио · Случайная |
| Preset · Amp (the model) · Cabinet | Пресет · Усилитель · Кабинет |
| Drive · Gate · Auto gate · Hum filter | Драйв · Шумодав · Автошумодав · Фильтр гула |
| Bass · Middle · Treble · Level · Master | Бас · Середина · Верх · Уровень · Мастер |
| Chorus · Delay · Reverb | Хорус · Дилей · Ревер |
| Mix · Rate · Depth · Time · Feedback | Микс · Скорость · Глубина · Время · Повторы |
| Spring · Plate | Пружина · Плита |
| Sound card · Buffer · Channel · Latency | Звуковая карта · Буфер · Канал · Задержка |
| Guitar path: ASIO · System audio | Звук гитары: ASIO · Системный звук |
| Set input level (G) | Настроить уровень (G) |
| Keys (the sheet) | Клавиши |
| Settings · Language | Настройки · Язык |

## Before and after

| before | en | ru |
|---|---|---|
| Нажми пробел — и играй | Press Space to play | Нажми пробел, чтобы играть |
| Подстроил: +6 дБ. Сильный удар теперь там, где на него рассчитаны комбики. | Input level: +6 dB | Уровень входа: +6 дБ |
| Петля 1:02–1:10 — крутится. R — выключить. | Loop 1:02–1:10 | Петля 1:02–1:10 |
| Сервис песен не отвечает. Он запускается… npm run dev. | Songs are unavailable. Restart Strum. | Песни недоступны. Перезапусти Strum. |
| делю на дорожки: 40 % | Separating: 40% | Разделение: 40 % |
| Не услышал гитару: проверь кабель и канал — и подстрой ещё раз. | No guitar heard. Check the cable and the channel, then try again. | Гитара не слышна. Проверь кабель и канал и попробуй снова. |
| Сколько | Mix | Микс |
| Шумодав сам | Auto gate | Автошумодав |
| Подстроить под мою гитару | Set input level | Настроить уровень |
| Отпусти — добавлю песню (mp3…), таб Guitar Pro (сыграю его сам)… | Drop to add: a song (mp3, m4a, wav, flac), a Guitar Pro tab, an amp model (.nam) or a cabinet (.wav) | Отпусти, чтобы добавить: песню (mp3, m4a, wav, flac), таб Guitar Pro, модель усилителя (.nam) или кабинет (.wav) |
