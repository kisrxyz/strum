"""The probe: can Python hold the guitar in real time?

    python -m kv_guitar.probe [--device NAME] [--buffer 128] [--minutes 10] [--preset drive] [--load] [--dry]

ASIO input 2 → drive → NAM → cabinet → level → soft clip → both outputs, with the time of every
callback measured. `--load` adds a second Python thread doing what the WebSocket server will
cost. `--dry` runs the same callback on a synthetic guitar without opening any sound device.
"""

from __future__ import annotations

import argparse
import gc
import os
import struct
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

# PortAudio only shows ASIO devices when this is set before the import.
os.environ.setdefault("SD_ENABLE_ASIO", "1")

from .assets import ENGINE_RATE, builtin_ir_path, builtin_model_path, nam_wasm_path, read_ir  # noqa: E402
from .convolve import PartitionedConvolver  # noqa: E402
from .irgain import db_to_lin, ir_in_band_gain_db  # noqa: E402
from .nam_wasm import NamWasm  # noqa: E402

# `OUTPUT_TRIM_DB` in src/audio/engine.ts.
OUTPUT_TRIM_DB = 0.0  # 3.0 until 2026-11-16 (see engine.ts)
# `makeSoftClipCurve` in src/dsp/curves.ts.
SOFT_CLIP_KNEE = 0.7
# `SLIM_SIZE` in src/audio/amp.ts.
SLIM_SIZE = 0.3
REPORT_EVERY_S = 10.0
# How often the main thread looks whether the stream is still alive.
POLL_S = 0.25
# An entry-to-entry interval over this many periods is a late callback («опоздание»).
LATE_PERIODS = 1.5
# A run may be this much shorter than planned before it counts as stopped early.
EARLY_SLACK_S = 0.5
# What the server thread sends: 10 ms of input, 100 times a second.
LOAD_FRAMES = 480
LOAD_PERIOD_S = 0.010
LOAD_BUSY_S = 0.001


@dataclass(frozen=True)
class ProbePreset:
    name: str
    model: str
    input_db: float
    cab: str
    level_db: float
    slim: bool = False


# Copied from DEFAULT_PRESETS in src/state/presets.ts (the amp, the cabinet and the level only).
PRESETS: dict[str, ProbePreset] = {
    "clean-chorus": ProbePreset("Чистый с хорусом", "nam:jc", 0.0, "ir:celestion", 5.5),
    "crunch": ProbePreset("Кранч", "nam:dumble", -12.0, "ir:celestion", 6.0),
    "drive": ProbePreset("Перегруз", "nam:jcm", 0.0, "ir:mesa", -0.5),
    "solo": ProbePreset("Соло", "nam:dumble", 2.0, "ir:celestion", -0.5),
}


class Chain:
    """Drive → NAM → cabinet → level → soft clip, one block at a time, nothing allocated."""

    def __init__(self, preset: ProbePreset, block: int, sample_rate: int = ENGINE_RATE) -> None:
        self.block = block
        self.nam = NamWasm(nam_wasm_path(), sample_rate, block)
        try:
            model_text = builtin_model_path(preset.model).read_text(encoding="utf-8")
        except OSError as error:
            raise RuntimeError("Не нашлись стартовые звуки. Запусти «npm run setup».") from error
        self.model_info = self.nam.load_model(model_text, SLIM_SIZE if preset.slim else -1.0)
        taps = read_ir(builtin_ir_path(preset.cab), sample_rate)
        self.cab_gain_db = ir_in_band_gain_db(taps, sample_rate)
        self.cab = PartitionedConvolver(taps * np.float32(db_to_lin(self.cab_gain_db)), block)
        self._drive = np.float32(db_to_lin(preset.input_db))
        self._level = np.float32(db_to_lin(preset.level_db + OUTPUT_TRIM_DB))
        self._knee = np.float32(SOFT_CLIP_KNEE)
        self._room = np.float32(1 - SOFT_CLIP_KNEE)
        self._work = np.zeros(block, dtype=np.float32)
        self._over = np.zeros(block, dtype=np.float32)

    def process(self, x: np.ndarray, out: np.ndarray) -> None:
        """`x`: one block of the dry guitar (any float32 view); `out`: float32 of the same length."""
        work = self._work
        np.multiply(x, self._drive, out=work)
        self.nam.process(work)
        self.cab.process(work, work)
        np.multiply(work, self._level, out=work)
        # Soft clip: identity below the knee, then knee + room·tanh((|x| − knee) / room).
        over = self._over
        np.abs(work, out=over)
        np.subtract(over, self._knee, out=over)
        np.maximum(over, 0, out=over)
        np.divide(over, self._room, out=over)
        np.tanh(over, out=over)
        np.multiply(over, self._room, out=over)
        np.copysign(over, work, out=over)
        np.clip(work, -self._knee, self._knee, out=work)
        np.add(work, over, out=out)


class Probe:
    """The callback and its counters. The audio thread writes, the main thread reads."""

    def __init__(
        self,
        chain: Chain,
        block: int,
        capacity: int,
        load_ring: np.ndarray | None = None,
        sample_rate: int = ENGINE_RATE,
        clock: Callable[[], int] = time.perf_counter_ns,
    ) -> None:
        self.chain = chain
        self.block = block
        self._clock = clock
        # How long each callback worked, from its first line to its last.
        self.times_ns = np.zeros(max(1, capacity), dtype=np.int64)
        self.count = 0
        self.max_ns = 0
        # From one callback's first line to the next one's. Unlike the working time, this also
        # shows a callback that started late — because another thread held the interpreter.
        self.gaps_ns = np.zeros(max(1, capacity), dtype=np.int64)
        self.gap_count = 0
        self.max_gap_ns = 0
        self.late = 0
        self._late_ns = int(LATE_PERIODS * block / sample_rate * 1e9)
        self._last_entry = 0
        self.xruns = 0
        self.input_overflows = 0
        self.output_underflows = 0
        self.odd_blocks = 0
        # What broke the callback, if anything did (sounddevice then aborts the stream).
        self.error: BaseException | None = None
        self._mono = np.zeros(block, dtype=np.float32)
        # The dry input for the «server» thread: a ring written here, read there.
        self.load_ring = load_ring
        self.load_written = 0

    def callback(self, indata: np.ndarray, outdata: np.ndarray, frames: int, _time: object, status: object) -> None:
        t0 = self._clock()
        last = self._last_entry
        self._last_entry = t0
        if last:
            gap = t0 - last
            self.gaps_ns[self.gap_count % len(self.gaps_ns)] = gap
            self.gap_count += 1
            if gap > self.max_gap_ns:
                self.max_gap_ns = gap
            if gap > self._late_ns:
                self.late += 1
        try:
            if status:
                self.xruns += 1
                if getattr(status, "input_overflow", False) or getattr(status, "input_underflow", False):
                    self.input_overflows += 1
                if getattr(status, "output_underflow", False) or getattr(status, "output_overflow", False):
                    self.output_underflows += 1
            if frames != self.block:
                # ASIO always gives whole blocks; anything else is played as silence and counted.
                self.odd_blocks += 1
                outdata.fill(0)
            else:
                # The guitar is in input 2 (the right channel), as on the cards we know.
                dry = indata[:, 1] if indata.shape[1] > 1 else indata[:, 0]
                mono = self._mono
                self.chain.process(dry, mono)
                outdata[:, 0] = mono
                if outdata.shape[1] > 1:
                    outdata[:, 1] = mono
                ring = self.load_ring
                if ring is not None:
                    at = self.load_written % len(ring)
                    ring[at : at + frames] = dry
                    self.load_written += frames
        except BaseException as error:
            if self.error is None:
                self.error = error
            raise
        elapsed = self._clock() - t0
        index = self.count
        self.times_ns[index % len(self.times_ns)] = elapsed
        self.count = index + 1
        if elapsed > self.max_ns:
            self.max_ns = elapsed


@dataclass(frozen=True)
class Stats:
    callbacks: int
    xruns: int
    p50_ms: float
    p99_ms: float
    max_ms: float
    budget_ms: float
    # Entry-to-entry intervals; the period they should have is `budget_ms`.
    gap_p99_ms: float = 0.0
    gap_max_ms: float = 0.0
    late: int = 0
    odd_blocks: int = 0
    # Why the run ended before its time, in Russian; empty when it did not.
    stopped: str = ""

    @property
    def problems(self) -> list[str]:
        found = []
        if self.stopped:
            found.append(self.stopped)
        if self.callbacks == 0:
            found.append("звук не пошёл (ни одного вызова)")
        if self.xruns:
            found.append(f"сбоев звука: {self.xruns}")
        if self.late:
            found.append(
                f"опозданий: {self.late} (вызов начался позже чем через {fmt(LATE_PERIODS * self.budget_ms)} мс "
                f"после предыдущего, а должен через {fmt(self.budget_ms)} мс)"
            )
        if self.odd_blocks:
            found.append(f"буферов не того размера: {self.odd_blocks}")
        if self.p99_ms >= self.budget_ms / 2:
            found.append(
                f"расчёт долгий: 99 % вызовов укладываются в {fmt(self.p99_ms)} мс, "
                f"а нужно меньше {fmt(self.budget_ms / 2)} мс (половина буфера)"
            )
        return found

    @property
    def verdict(self) -> str:
        problems = self.problems
        return "Пробник прошёл" if not problems else "Пробник не прошёл: " + "; ".join(problems)


@dataclass
class RunInfo:
    """What the run itself knows, for the reports."""

    latency: tuple[float, float] | None = None
    cpu_load: float | None = None
    stopped: str = ""
    interrupted: bool = False


def fmt(value: float, digits: int = 2) -> str:
    return f"{value:.{digits}f}".replace(".", ",")


def stats_of(
    times_ns: np.ndarray,
    callbacks: int,
    xruns: int,
    max_ns: int,
    block: int,
    sample_rate: int,
    *,
    gaps_ns: np.ndarray | None = None,
    max_gap_ns: int = 0,
    late: int = 0,
    odd_blocks: int = 0,
    stopped: str = "",
) -> Stats:
    """`times_ns`, `gaps_ns`: the values to judge (copies); the `max_*` and counts are of the whole run."""
    budget_ms = block / sample_rate * 1000
    p50 = p99 = gap_p99 = 0.0
    if len(times_ns):
        ms = times_ns / 1e6
        p50, p99 = float(np.percentile(ms, 50)), float(np.percentile(ms, 99))
    if gaps_ns is not None and len(gaps_ns):
        gap_p99 = float(np.percentile(gaps_ns / 1e6, 99))
    return Stats(
        callbacks, xruns, p50, p99, max_ns / 1e6, budget_ms,
        gap_p99_ms=gap_p99, gap_max_ms=max_gap_ns / 1e6, late=late, odd_blocks=odd_blocks, stopped=stopped,
    )  # fmt: skip


def late_count(gaps_ns: np.ndarray, block: int, sample_rate: int) -> int:
    """How many entry-to-entry intervals are over 1.5 periods (what the callback counts as it goes)."""
    return int(np.count_nonzero(gaps_ns > int(LATE_PERIODS * block / sample_rate * 1e9)))


def ring_tail(ring: np.ndarray, count: int, last: int | None = None) -> np.ndarray:
    """A copy of what was written to a ring `count` times: all that is still there, or the `last` ones."""
    size = len(ring)
    have = min(count, size)
    take = have if last is None else min(have, last)
    if count <= size:
        return ring[count - take : count].copy()
    idx = (count % size - take + np.arange(take)) % size
    return ring[idx]


def window(probe: Probe, last: int | None = None) -> np.ndarray:
    """A copy of the measured working times: all of them, or the `last` ones."""
    return ring_tail(probe.times_ns, probe.count, last)


def probe_stats(probe: Probe, sample_rate: int, last: int | None = None, stopped: str = "") -> Stats:
    return stats_of(
        window(probe, last),
        probe.count,
        probe.xruns,
        probe.max_ns,
        probe.block,
        sample_rate,
        gaps_ns=ring_tail(probe.gaps_ns, probe.gap_count, last),
        max_gap_ns=probe.max_gap_ns,
        late=probe.late,
        odd_blocks=probe.odd_blocks,
        stopped=stopped,
    )


def report(probe: Probe, sample_rate: int, info: RunInfo | None, title: str, last: int | None, stopped: str = "") -> Stats:
    """Prints the numbers. Percentiles are of the `last` callbacks; counts and maxima of the whole run."""
    stats = probe_stats(probe, sample_rate, last, stopped)
    lines = [
        title,
        f"  сбоев звука (xruns) за всё время: {stats.xruns}"
        + (f" (вход: {probe.input_overflows}, выход: {probe.output_underflows})" if stats.xruns else ""),
        f"  расчёт одного буфера: обычно {fmt(stats.p50_ms)} мс, 99 % — до {fmt(stats.p99_ms)} мс, "
        f"самый долгий за всё время {fmt(stats.max_ms)} мс",
        f"  от вызова до вызова: 99 % — до {fmt(stats.gap_p99_ms)} мс, самый долгий за всё время "
        f"{fmt(stats.gap_max_ms)} мс (должно быть {fmt(stats.budget_ms)} мс); опозданий за всё время: {stats.late}",
        f"  буфер: {probe.block} отсчётов = {fmt(stats.budget_ms)} мс; вызовов: {stats.callbacks}",
    ]
    if info is not None and info.cpu_load is not None:
        lines.append(f"  загрузка звукового потока по счёту драйвера: {fmt(info.cpu_load * 100, 0)} %")
    if info is not None and info.latency is not None:
        lines.append(
            f"  задержка драйвера: вход {fmt(info.latency[0] * 1000, 1)} мс, выход {fmt(info.latency[1] * 1000, 1)} мс"
        )
    lines.append(f"  {stats.verdict}")
    print("\n".join(lines), flush=True)
    return stats


# --- the device ---------------------------------------------------------------------------------


def find_device(devices: list[dict], hostapis: list[dict], name: str) -> int | None:
    """Index of the device whose name has `name` in it and that can do 2 in / 2 out. ASIO wins."""
    wanted = name.casefold()
    found: list[tuple[int, int]] = []
    for index, device in enumerate(devices):
        if wanted not in str(device["name"]).casefold():
            continue
        if device["max_input_channels"] < 2 or device["max_output_channels"] < 2:
            continue
        api = str(hostapis[device["hostapi"]]["name"])
        found.append((0 if "asio" in api.casefold() else 1, index))
    return min(found)[1] if found else None


def device_list_text(devices: list[dict], hostapis: list[dict]) -> str:
    lines = []
    for index, device in enumerate(devices):
        api = hostapis[device["hostapi"]]["name"]
        lines.append(
            f"  {index:3d}  {' '.join(str(device['name']).split())}  [{api}]  "
            f"входов: {device['max_input_channels']}, выходов: {device['max_output_channels']}"
        )
    return "\n".join(lines) if lines else "  (звуковых устройств нет)"


# --- the «server» thread ------------------------------------------------------------------------


def busy_loops_for(seconds: float) -> int:
    """How many turns of the busy loop take `seconds` on this machine."""
    turns = 20000
    t0 = time.perf_counter()
    _busy(turns)
    took = time.perf_counter() - t0
    return max(1, int(turns * seconds / max(took, 1e-9)))


def _busy(turns: int) -> int:
    total = 0
    for i in range(turns):
        total += i * i % 7
    return total


def load_thread(probe: Probe, stop: threading.Event, frames_sent: list[int]) -> None:
    """Every 10 ms: the last 480 input frames as a KVG1 packet, plus ~1 ms of pure-Python work."""
    ring = probe.load_ring
    assert ring is not None
    size = len(ring)
    chunk = np.zeros(LOAD_FRAMES, dtype=np.float32)
    turns = busy_loops_for(LOAD_BUSY_S)
    seq = 0
    deadline = time.perf_counter()
    while not stop.is_set():
        end = probe.load_written % size
        start = (end - LOAD_FRAMES) % size
        if start < end:
            chunk[:] = ring[start:end]
        else:
            head = size - start
            chunk[:head] = ring[start:]
            chunk[head:] = ring[:end]
        packet = struct.pack("<4sIQI", b"KVG1", seq & 0xFFFFFFFF, probe.load_written, LOAD_FRAMES) + chunk.tobytes()
        frames_sent[0] += 1 if packet else 0
        _busy(turns)
        seq += 1
        deadline += LOAD_PERIOD_S
        pause = deadline - time.perf_counter()
        if pause > 0:
            # time.sleep is precise on Windows (a high-resolution timer); Event.wait is not.
            time.sleep(pause)
        else:
            deadline = time.perf_counter()


# --- running ------------------------------------------------------------------------------------


def synthetic_guitar(block: int, sample_rate: int, seconds: float = 2.0) -> np.ndarray:
    """Plucked notes peaking near −9 dBFS, as stereo blocks (frames, 2) with the guitar on the right."""
    count = int(seconds * sample_rate) // block * block
    t = np.arange(count) / sample_rate
    note = np.zeros(count)
    for harmonic, level in ((1, 1.0), (2, 0.5), (3, 0.33), (4, 0.2), (5, 0.12)):
        note += level * np.sin(2 * np.pi * 110.0 * harmonic * t)
    envelope = np.exp(-(t % 0.5) * 5.0)
    mono = note * envelope
    mono *= 10 ** (-9 / 20) / np.max(np.abs(mono))
    stereo = np.zeros((count, 2), dtype=np.float32)
    stereo[:, 1] = mono
    return stereo


def warm_up(probe: Probe, sample_rate: int) -> None:
    """Runs the callback's work before the stream starts, then freezes the garbage collector."""
    guitar = synthetic_guitar(probe.block, sample_rate, 1.0)
    out = np.zeros(probe.block, dtype=np.float32)
    for start in range(0, len(guitar), probe.block):
        probe.chain.process(guitar[start : start + probe.block, 1], out)
    probe.chain.cab.reset()
    gc.collect()
    gc.disable()
    gc.freeze()
    sys.setswitchinterval(0.0005)


def run_dry(probe: Probe, sample_rate: int, seconds: float, stop: threading.Event) -> None:
    """The callback on a synthetic guitar, one block per block time, without a sound device."""
    block = probe.block
    guitar = synthetic_guitar(block, sample_rate)
    outdata = np.zeros((block, 2), dtype=np.float32)
    blocks = len(guitar) // block
    total = planned_callbacks(seconds, sample_rate, block)
    period = block / sample_rate
    started = time.perf_counter()
    next_report = started + REPORT_EVERY_S
    per_report = int(REPORT_EVERY_S * sample_rate / block)
    for i in range(total):
        if stop.is_set():
            break
        at = (i % blocks) * block
        probe.callback(guitar[at : at + block], outdata, block, None, None)
        # Keep the pace of a real card. Sleeping is too coarse on Windows, so spin politely.
        deadline = started + (i + 1) * period
        while time.perf_counter() < deadline:
            time.sleep(0)
        if time.perf_counter() >= next_report:
            report(probe, sample_rate, None, "Пробник без звуковой карты, последние 10 секунд:", per_report)
            next_report += REPORT_EVERY_S


def asio_buffer_sizes(sd: Any, device: int, loader: Callable[[str], Any] | None = None) -> tuple[int, int, int, int] | None:
    """The ASIO driver's buffer sizes (min, max, preferred, granularity), or None when not known.

    sounddevice does not wrap `PaAsio_GetAvailableBufferSizes`, but its PortAudio DLL has it, so
    the same DLL is asked through ctypes. Any trouble means «not known»: this is only a hint.
    """
    name = "PaAsio_GetAvailableBufferSizes"
    try:
        wrapped = getattr(sd._lib, name, None)
    except Exception:
        wrapped = None
    try:
        if wrapped is not None:
            cells = [sd._ffi.new("long *") for _ in range(4)]
            if wrapped(device, *cells) != 0:
                return None
            return (int(cells[0][0]), int(cells[1][0]), int(cells[2][0]), int(cells[3][0]))
        import ctypes

        library = (loader or ctypes.CDLL)(sd._libname)
        function = getattr(library, name)
        function.argtypes = [ctypes.c_int] + [ctypes.POINTER(ctypes.c_long)] * 4
        function.restype = ctypes.c_int
        values = [ctypes.c_long(0) for _ in range(4)]
        if function(device, *[ctypes.byref(value) for value in values]) != 0:
            return None
        return (values[0].value, values[1].value, values[2].value, values[3].value)
    except Exception:
        return None


def buffer_sizes_text(sizes: tuple[int, int, int, int], block: int) -> str:
    low, high, preferred, step = sizes
    text = f"Буферы драйвера ASIO: от {low} до {high} отсчётов, сам драйвер выбирает {preferred}"
    if step > 0:
        text += f", шаг {step}"
    elif step == -1:
        text += ", размеры — степени двойки"
    text += "."
    if preferred != block:
        text += (
            f" Пробник просит {block}: если задержка драйвера ниже окажется больше, чем ждёшь, "
            f"поставь {block} в панели драйвера карты."
        )
    return text


def run_stream(
    probe: Probe, device: int, sample_rate: int, seconds: float, stop: threading.Event, info: RunInfo, asio: bool = True
) -> None:
    import sounddevice as sd

    if asio:
        sizes = asio_buffer_sizes(sd, device)
        if sizes is not None:
            print(buffer_sizes_text(sizes, probe.block), flush=True)
    per_report = int(REPORT_EVERY_S * sample_rate / probe.block)
    with sd.Stream(
        device=(device, device),
        samplerate=sample_rate,
        blocksize=probe.block,
        channels=2,
        dtype="float32",
        latency="low",
        callback=probe.callback,
    ) as stream:
        info.latency = (float(stream.latency[0]), float(stream.latency[1]))
        print(
            f"Играй! Блок потока: {stream.blocksize} отсчётов. Задержка драйвера: вход "
            f"{fmt(info.latency[0] * 1000, 1)} мс, выход {fmt(info.latency[1] * 1000, 1)} мс. "
            "Остановить раньше — Ctrl+C.",
            flush=True,
        )
        started = time.monotonic()
        end = started + seconds
        next_report = started + REPORT_EVERY_S
        while not stop.is_set():
            now = time.monotonic()
            if now >= end:
                break
            if not stream.active:
                # A failed callback or the driver itself stopped the stream.
                info.stopped = (
                    f"звук остановился раньше времени: через {fmt(now - started, 1)} с из {fmt(seconds, 1)} с"
                )
                break
            if now >= next_report:
                info.cpu_load = float(stream.cpu_load)
                report(probe, sample_rate, info, "Последние 10 секунд:", per_report)
                next_report += REPORT_EVERY_S
            stop.wait(min(POLL_S, end - now))
        try:
            info.cpu_load = float(stream.cpu_load)
        except Exception:
            pass


def planned_callbacks(seconds: float, sample_rate: int, block: int) -> int:
    return int(seconds * sample_rate / block)


def early_stop_text(probe: Probe, info: RunInfo, seconds: float, sample_rate: int) -> str:
    """Why the run did not reach its planned end, in Russian; empty when it did (or on Ctrl+C)."""
    if probe.error is not None:
        reason = str(probe.error).strip() or type(probe.error).__name__
        return f"расчёт сломался на вызове {probe.count + 1}, и звук остановился: {reason}"
    if info.stopped:
        return info.stopped
    if info.interrupted:
        return ""
    planned = planned_callbacks(seconds, sample_rate, probe.block)
    # A stream takes a moment to start, and the card's clock is not the computer's.
    slack = max(0.02 * planned, EARLY_SLACK_S * sample_rate / probe.block)
    if probe.count < planned - slack:
        return f"звук остановился раньше времени: вызовов {probe.count} из {planned}"
    return ""


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="probe:guitar", description="Пробник: гитара через ASIO, усилитель NAM и кабинет.")
    parser.add_argument("--device", default="M-Track", help="часть названия звуковой карты (по умолчанию M-Track)")
    parser.add_argument("--buffer", type=int, default=128, help="размер буфера в отсчётах (128 или 64)")
    parser.add_argument("--minutes", type=float, default=10.0, help="сколько минут играть")
    parser.add_argument("--preset", default="drive", choices=sorted(PRESETS), help="звук комбика")
    parser.add_argument("--load", action="store_true", help="добавить работу, как у будущего сервера")
    parser.add_argument("--dry", action="store_true", help="без звуковой карты: проверить расчёт на записанном сигнале")
    args = parser.parse_args(argv)
    if not 16 <= args.buffer <= 4096:
        parser.error("буфер: от 16 до 4096 отсчётов")
    if not args.minutes > 0:
        parser.error("минуты: больше нуля")
    return args


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args(argv)
    sample_rate = ENGINE_RATE
    seconds = args.minutes * 60

    device = None
    asio = False
    if not args.dry:
        try:
            import sounddevice as sd

            devices = [dict(d) for d in sd.query_devices()]
            hostapis = [dict(a) for a in sd.query_hostapis()]
        except Exception as error:  # PortAudio missing or broken
            print(f"Не получилось посмотреть звуковые устройства: {error}", flush=True)
            return 1
        device = find_device(devices, hostapis, args.device)
        if device is None:
            print(
                f"Не нашёл звуковую карту «{args.device}» с двумя входами и двумя выходами.\n"
                "Проверь, что карта подключена и её драйвер ASIO установлен. Вот что видит компьютер:\n"
                f"{device_list_text(devices, hostapis)}\n"
                "Другую карту можно назвать так: npm run probe:guitar -- --device \"часть названия\"",
                flush=True,
            )
            return 1
        api = hostapis[devices[device]["hostapi"]]["name"]
        asio = "asio" in str(api).casefold()
        print(f"Звуковая карта: {devices[device]['name']} [{api}]", flush=True)
        if not asio:
            print("Внимание: это не ASIO, задержка будет большой. Нужен драйвер ASIO этой карты.", flush=True)

    preset = PRESETS[args.preset]
    try:
        chain = Chain(preset, args.buffer, sample_rate)
    except (RuntimeError, ValueError) as error:
        print(str(error), flush=True)
        return 1
    capacity = planned_callbacks(seconds, sample_rate, args.buffer) + 4096
    ring = np.zeros(args.buffer * 1024, dtype=np.float32) if args.load else None
    probe = Probe(chain, args.buffer, capacity, ring, sample_rate)
    print(
        f"Звук «{preset.name}», буфер {args.buffer} отсчётов ({fmt(args.buffer / sample_rate * 1000)} мс), "
        f"{fmt(args.minutes, 1)} мин" + (", с нагрузкой сервера" if args.load else "") + ".",
        flush=True,
    )

    stop = threading.Event()
    worker = None
    sent = [0]
    warm_up(probe, sample_rate)
    if args.load:
        worker = threading.Thread(target=load_thread, args=(probe, stop, sent), name="kv-probe-load", daemon=True)
        worker.start()

    info = RunInfo()
    failure = ""
    try:
        if args.dry:
            run_dry(probe, sample_rate, seconds, stop)
        else:
            assert device is not None
            run_stream(probe, device, sample_rate, seconds, stop, info, asio)
    except KeyboardInterrupt:
        info.interrupted = True
        print("Остановлено.", flush=True)
    except Exception as error:  # the driver refused the stream; a failed callback is in probe.error
        if probe.error is None:
            failure = str(error)
    finally:
        stop.set()
        if worker is not None:
            worker.join(timeout=1.0)
        gc.unfreeze()
        gc.enable()

    if failure:
        print(f"Пробник не прошёл: звуковая карта не запустилась ({failure}).", flush=True)
        return 1
    stopped = early_stop_text(probe, info, seconds, sample_rate)
    if args.dry:
        title = "Итог без звуковой карты (только расчёт):"
    elif info.interrupted:
        title = "Итог (остановлено раньше времени, по Ctrl+C):"
    else:
        title = "Итог:"
    stats = report(probe, sample_rate, info, title, None, stopped)
    if args.load:
        print(f"  пакетов «сервера» собрано: {sent[0]}", flush=True)
    if stopped:
        return 1
    return 0 if not stats.problems else 2


if __name__ == "__main__":
    sys.exit(main())
