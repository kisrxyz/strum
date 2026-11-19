# Privacy

[Русский](privacy.ru.md) · 19 November 2026

Strum collects nothing about you. It has no accounts, no analytics, no ads and no crash reports.

## What stays on your computer

Your songs, their stems, your takes, your settings and your own amp files stay in `C:\Users\<you>\Strum`. Python, the downloaded models and the logs stay in `%LOCALAPPDATA%\app.strum`. Strum never uploads any of it.

Strum listens to the audio input you pick in Settings, to play your guitar through the amp. That sound is handled on your computer and is saved only while you press Record.

## When Strum goes online

Only in these cases:

| When | What is downloaded or sent | Where |
|---|---|---|
| Installing, if Windows lacks it | Microsoft Edge WebView2, the window Strum runs in | Microsoft |
| The first launch | Python and its packages | github.com, pypi.org |
| You press **Download** on Songs | the song separation packages and models | pypi.org, download.pytorch.org, huggingface.co, cloud.cp.jku.at |
| You ask Strum to recognize the words of the vocals | the words model | huggingface.co |
| You press **Find lyrics online** | the song's artist, title and length are sent | lrclib.net |

These sites see your IP address, as with any download, and their own privacy policies apply. Strum sends them nothing else.

Strum's window is Microsoft Edge WebView2. Windows sends its diagnostic data to Microsoft as your Windows diagnostic data settings allow, the same as for Edge.

## Questions

Ask in an [issue on GitHub](../../../issues).
