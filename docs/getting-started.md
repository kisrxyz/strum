# Getting started

From the installer to playing along with a song in about ten minutes. [Русский](getting-started.ru.md)

## 1. Plug in

- The guitar goes into the instrument input of your audio interface. It is often marked Hi-Z, INST or with a guitar. If the input has a switch, set it to instrument.
- Plug headphones or monitors into the interface, not into the computer's own jack. That keeps the delay lowest.
- Install the interface's driver from its maker's website. Most cards come with an ASIO driver, and Strum uses it for the lowest delay.

## 2. Install and open

Download the installer and run it: [Download](../README.md#download) shows where to click when Windows warns about it. On its first launch Strum gets itself ready for a minute or two. It needs the internet for that, once.

## 3. Set up the guitar

The first launch opens **Settings** with *Set up your guitar* on top.

1. **Audio driver:** ASIO if your card has one, otherwise System audio.
2. **Sound card:** pick yours.
3. **Buffer:** leave it as it is. If the sound crackles, pick a bigger one.
4. **Channel:** Auto finds the input your guitar is plugged into at the first note.
5. Strum the strings: the **Input level** meter moves. Press **Set input level** (key G) and strum a few times as hard as you play in the loudest part. Strum sets the input so the amps sound as they should. If it says the card itself overloads, turn the Gain knob on the card down and try again.
6. Press **Done**.

**Latency** shows how long it takes from the string to the sound. Under about 10 ms feels instant.

## 4. The amp

Open **Amp** on the left panel (key K).

- Four presets: Clean chorus, Crunch, Drive and Lead. Switch them with the keys 1–4 or PageUp / PageDown. A Bluetooth page-turner pedal sends those keys too, so it switches presets with your foot.
- Knobs: drag up or down (with Shift for finer steps), or turn the mouse wheel. A double-click puts a knob back.
- Under the head: the cabinet and three pedals (chorus, delay, reverb). Click a footswitch to turn a pedal on.
- Your own sound: **Your own file** at the top of the head, or drop a `.nam` amp model (for example from tone3000.com) or a `.wav` cabinet into the window. It goes into the current preset.
- Every change is saved in the preset by itself.

The **Tuner** is on the left panel too (key T).

## 5. Add a song

Open **Songs** (key L) and press **Add song**, or drop an mp3, m4a, wav or flac file into the window.

- **The first time only:** the strip on top offers to **Download** song separation. It is about 3 GB with an NVIDIA graphics card and about 0.5 GB without one, and the strip shows what is left. Songs you add meanwhile wait for it.
- Then Strum splits the song into vocals, drums, bass, guitar, keys and the rest, and finds its bars, chords and key. With an NVIDIA card this takes under a minute, on the processor a few minutes.
- A Guitar Pro (`.gp`, `.gp5`, `.gpx`) or MusicXML file dropped on Songs becomes a song that Strum plays itself from the tab, drums and bass included.
- A separated song takes about 100 MB of disk space.

## 6. Play along

Double-click a song, or select it and press Enter: it opens in the **Player**. Space plays and pauses.

- The guitar of the recording is turned off: that part is yours. **Original guitar** (G) brings it back.
- On top: **Chords**, **Lyrics**, **Tab** and **Notes** (W switches them).
- In the transport at the bottom: **Speed** (− and =), **Pitch** (, and .), **Loop** (R; A and B set where it starts and ends, Q loops the part you are in), the **Metronome**, the **Mixer** with the volume of each part, and the **Fretboard** (F) with the fingering of the chord.
- Volumes: ↑ ↓ change both, with Alt only the guitar, with Shift only the song.
- **Lyrics:** copy them with chords from any website and press Ctrl+V in the player, or open **Add lyrics** → **Find lyrics online**. Strum times the lines to the song.
- **Tab:** in the Tab view, drop a Guitar Pro or MusicXML file, or paste a text tab with Ctrl+V. It follows the recording.
- **Options** (top right): capo, tuning, play by ear, match song tone, count-in, stage view and more.

## 7. Record yourself

**Record** on the left panel (key \\) records your guitar and the song as you hear them. Press it again to stop. The takes are in **Songs** → **Takes**: listen, move the guitar a little earlier or later against the song, save an mp3.

## Keys

Every action has a key, so you can keep the guitar in your hands. F1 shows them all, and the tooltips show them too.

Something does not work? See [Troubleshooting](troubleshooting.md).
