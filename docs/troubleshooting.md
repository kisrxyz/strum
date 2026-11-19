# Troubleshooting

[Русский](troubleshooting.ru.md)

## Installing

**Windows says it protected your PC.** The installer is not signed yet. Click **More info**, then **Run anyway**: [pictures in Download](../README.md#download).

**Windows blocks it with no Run anyway button.** Smart App Control is on, and it blocks every unsigned program. It can be turned off in Windows Security → App & browser control → Smart App Control. It guards against unknown programs, so turn it off only if you are fine with that.

**The antivirus deleted the installer.** New programs without a signature are sometimes flagged by mistake. You can send the file to Microsoft to check, free: [microsoft.com/wdsi/filesubmission](https://www.microsoft.com/en-us/wdsi/filesubmission).

## Starting

**"Couldn't download what Strum needs."** The first launch downloads Python and its packages (about 150 MB). Check the internet, and if you are behind a proxy or a strict firewall, let Strum through. Then open Strum again.

**"Some program files are missing."** Reinstall Strum. Your songs and settings stay.

**Strum doesn't start in time, or the window stays empty.** Close Strum and open it again. If that happens every time, the start screen shows the folder with its logs: attach them to a [bug report](#reporting-a-bug).

## No sound

**The Input level meter in Settings doesn't move.**
- Is the guitar in the interface's instrument input, and is the guitar's volume knob up?
- A plain adapter into the computer's headphone jack won't work: that jack has no input.
- **Channel:** pick Left or Right by hand if Auto guesses wrong.
- Close programs that may hold the card: a call, a DAW, another guitar program.

**The meter moves, but the guitar is silent.**
- The guitar may be muted: the status bar at the bottom says *Guitar muted*. Press M.
- Are the headphones in the interface?

**My card isn't in the list.** Install its ASIO driver from the maker's website and open Strum again. If the card has no ASIO driver, pick **System audio**: it works with any card, with more delay.

**"ASIO did not start. The guitar plays through system audio."** Another program holds the card, or the driver is busy. Close the other programs: Strum switches back to ASIO by itself.

**The guitar plays, but the song is silent, or comes out of the laptop's speakers.** The song plays through Windows sound:
- Make your interface the default output: Windows Settings → System → Sound → Output.
- Check that Strum is not turned down in the Volume mixer (same page, at the bottom).
- Some drivers don't let Windows play while ASIO is open. Then pick **System audio** in Settings → Audio driver.

## Delay and crackles

**The sound lags behind the strings.** Use ASIO, pick a smaller **Buffer**, plug the headphones into the interface and close other programs. If Strum says *Latency jumped*, unplug the card's USB and plug it back in.

**The sound crackles or clicks.** Pick a bigger **Buffer**. Plug the laptop into power and set Windows to best performance. The Lead preset takes the most processor time.

**"The sound card did not open at 48 000 Hz."** Set the card to 48 000 Hz in its own control panel and in Windows: Settings → System → Sound → your device → Format.

## The guitar sound

**Too quiet or too loud.** Settings → **Set input level** (G), then strum hard a few times. A good level is when a hard strum reaches the amber band of the meter. If Strum says the card overloads, turn the card's Gain down; if it is too quiet, turn Gain up.

**Hum or hiss.** On the Amp screen, the **Hum filter** removes mains hum: Auto finds 50 or 60 Hz itself. **Auto gate** silences the noise between notes. Single-coil pickups hum more: turn a little away from the computer and the screen.

**Your own amp model sounds odd.** Strum takes `.nam` files (Neural Amp Modeler) and `.wav` cabinets. A `.nam` capture of a full rig already has a cabinet in it: pick **No cabinet** for it.

## Songs

**Song separation doesn't download.** Check the internet and the free space: about 3 GB with an NVIDIA card, plus about 100 MB for each song. Then press **Try again** on the Songs screen.

**Separation is slow.** Without an NVIDIA card it runs on the processor: a few minutes per song. Strum uses an NVIDIA card from the GTX 16 series or newer with driver 580 or later. Update the driver from nvidia.com.

**The chords or the bars are off.** Click a chord to change it. If the bar lines are a beat off, move them in **Options** → Bar lines (Shift+[ and Shift+]).

**No lyrics found online.** Copy them with chords from any website and press Ctrl+V in the player.

## Reporting a bug

Open an [issue on GitHub](../../../issues/new/choose). Please add:
- the version (Settings → About and licenses);
- your Windows version, your audio interface, and whether you have an NVIDIA card;
- what you did, what you expected and what happened;
- the logs if Strum failed: the folder `%LOCALAPPDATA%\app.strum\logs` (paste it into the Explorer address bar).

Logs hold no audio, only what Strum did, but they may show file names and your Windows user name: look through them before you attach them.

## Uninstalling

Windows Settings → Apps → Installed apps → Strum → Uninstall. Your songs, takes and settings in `C:\Users\<you>\Strum` stay: delete that folder by hand if you don't need them.
