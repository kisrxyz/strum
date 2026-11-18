"""The probe without a sound card: the chain, the counters, the device search, the dry run."""

import gc
import sys

import numpy as np
import pytest

from kv_guitar import probe as probe_module
from kv_guitar.assets import nam_wasm_path, repo_root
from kv_guitar.probe import (
    PRESETS,
    Chain,
    Probe,
    device_list_text,
    find_device,
    main,
    stats_of,
    synthetic_guitar,
    window,
)

SR = 48000

needs_assets = pytest.mark.skipif(
    not (repo_root() / "public" / "tones" / "models" / "jcm.nam").exists() or not nam_wasm_path().exists(),
    reason="public/tones or public/nam is missing: run npm run setup",
)

APIS = [{"name": "MME"}, {"name": "Windows WASAPI"}, {"name": "ASIO"}]


def dev(name: str, api: int, ins: int, outs: int) -> dict:
    return {"name": name, "hostapi": api, "max_input_channels": ins, "max_output_channels": outs}


@pytest.fixture(autouse=True)
def restore_interpreter():
    # The probe freezes the garbage collector and shortens the switch interval.
    interval = sys.getswitchinterval()
    yield
    gc.unfreeze()
    gc.enable()
    sys.setswitchinterval(interval)


def test_find_device_prefers_asio_and_needs_two_in_two_out():
    devices = [
        dev("Line (M-Track Solo)", 0, 2, 0),
        dev("M-Track Solo duplex", 1, 2, 2),
        dev("M-Audio M-Track Solo and Duo ASIO", 2, 2, 2),
        dev("Realtek ASIO", 2, 2, 2),
    ]
    assert find_device(devices, APIS, "m-track") == 2
    assert find_device(devices[:2], APIS, "M-Track") == 1
    assert find_device(devices[:1], APIS, "M-Track") is None
    assert find_device(devices, APIS, "Behringer") is None


def test_device_list_text_names_every_device():
    text = device_list_text([dev("Динамики", 0, 0, 2), dev("UMC ASIO", 2, 2, 2)], APIS)
    assert "Динамики" in text and "[ASIO]" in text and "входов: 2" in text
    assert "нет" in device_list_text([], APIS)


def test_stats_verdict():
    quick = np.full(1000, 400_000, dtype=np.int64)
    ok = stats_of(quick, 1000, 0, 500_000, 128, SR)
    assert ok.budget_ms == pytest.approx(2.6667, abs=1e-3)
    assert ok.p50_ms == pytest.approx(0.4) and ok.max_ms == pytest.approx(0.5)
    assert ok.verdict == "Пробник прошёл"

    with_xruns = stats_of(quick, 1000, 3, 500_000, 128, SR)
    assert with_xruns.verdict.startswith("Пробник не прошёл") and "3" in with_xruns.verdict

    slow = quick.copy()
    slow[:50] = 1_500_000  # 5 % of the callbacks over half the buffer
    late = stats_of(slow, 1000, 0, 1_500_000, 128, SR)
    assert late.verdict.startswith("Пробник не прошёл") and "1,33" in late.verdict

    assert stats_of(np.zeros(0, dtype=np.int64), 0, 0, 0, 128, SR).verdict.startswith("Пробник не прошёл")


class FakeChain:
    block = 64

    def process(self, x, out):
        np.multiply(x, 2, out=out)


class Flags:
    def __init__(self, input_overflow=False, output_underflow=False):
        self.input_overflow = input_overflow
        self.output_underflow = output_underflow

    def __bool__(self):
        return self.input_overflow or self.output_underflow


def test_callback_plays_input_two_on_both_outputs_and_counts():
    ring = np.zeros(64 * 4, dtype=np.float32)
    probe = Probe(FakeChain(), 64, 8, ring)
    indata = np.zeros((64, 2), dtype=np.float32)
    indata[:, 0] = 0.9  # input 1 is not the guitar
    indata[:, 1] = 0.25
    outdata = np.zeros((64, 2), dtype=np.float32)

    probe.callback(indata, outdata, 64, None, Flags())
    assert np.allclose(outdata, 0.5)
    assert probe.count == 1 and probe.xruns == 0 and probe.max_ns > 0
    assert np.allclose(ring[:64], 0.25) and probe.load_written == 64

    probe.callback(indata, outdata, 64, None, Flags(input_overflow=True))
    probe.callback(indata, outdata, 64, None, Flags(output_underflow=True))
    assert probe.xruns == 2 and probe.input_overflows == 1 and probe.output_underflows == 1

    outdata[:] = 1
    probe.callback(indata[:32], outdata[:32], 32, None, None)
    assert probe.odd_blocks == 1 and np.all(outdata[:32] == 0)


def test_window_returns_the_latest_times_after_the_ring_wraps():
    probe = Probe(FakeChain(), 64, 4)
    for value in range(1, 7):
        probe.times_ns[probe.count % 4] = value
        probe.count += 1
    assert sorted(window(probe)) == [3, 4, 5, 6]
    assert list(window(probe, 2)) == [5, 6]
    fresh = Probe(FakeChain(), 64, 4)
    fresh.times_ns[0] = 9
    fresh.count = 1
    assert list(window(fresh)) == [9] and list(window(fresh, 10)) == [9]


@needs_assets
@pytest.mark.parametrize("block", [128, 64])
def test_chain_on_a_synthetic_guitar(block):
    chain = Chain(PRESETS["drive"], block, SR)
    assert chain.cab_gain_db == pytest.approx(-14.859, abs=0.01)
    guitar = synthetic_guitar(block, SR, 1.0)
    assert np.max(np.abs(guitar[:, 1])) == pytest.approx(10 ** (-9 / 20), rel=1e-3)
    assert not guitar[:, 0].any()
    out = np.zeros(len(guitar), dtype=np.float32)
    for start in range(0, len(guitar), block):
        chain.process(guitar[start : start + block, 1], out[start : start + block])
    assert np.all(np.isfinite(out))
    assert np.max(np.abs(out)) < 1.0  # the soft clip never reaches full scale
    rms_db = 10 * np.log10(np.mean(out.astype(np.float64) ** 2))
    # Presets are calibrated to about -18 dB RMS for a DI guitar peaking at -9 dBFS.
    assert -30 < rms_db < -8


@needs_assets
def test_chain_soft_clip_matches_the_curve_formula():
    chain = Chain(PRESETS["drive"], 64, SR)

    class Loud:
        def process(self, x, out):
            out[:] = np.linspace(-3, 3, 64, dtype=np.float32)

    chain.cab = Loud()
    chain._level = np.float32(1)
    out = np.zeros(64, dtype=np.float32)
    chain.process(np.zeros(64, dtype=np.float32), out)
    x = np.linspace(-3, 3, 64)
    knee, room = 0.7, 0.3
    want = np.where(np.abs(x) <= knee, x, np.sign(x) * (knee + room * np.tanh((np.abs(x) - knee) / room)))
    np.testing.assert_allclose(out, want, atol=1e-6)


def test_unknown_device_lists_devices_and_exits_1(monkeypatch, capsys):
    import sounddevice as sd

    monkeypatch.setattr(sd, "query_devices", lambda: [dev("Динамики (Realtek)", 0, 0, 2)])
    monkeypatch.setattr(sd, "query_hostapis", lambda: APIS)
    monkeypatch.setattr(sd, "Stream", lambda **kwargs: pytest.fail("the probe must not open a stream here"))
    assert main(["--device", "Нет такой карты", "--minutes", "0.01"]) == 1
    printed = capsys.readouterr().out
    assert "Не нашёл звуковую карту «Нет такой карты»" in printed
    assert "Динамики (Realtek)" in printed


def test_bad_arguments_exit_2():
    with pytest.raises(SystemExit) as caught:
        main(["--buffer", "3"])
    assert caught.value.code == 2
    with pytest.raises(SystemExit):
        main(["--preset", "metal"])


@needs_assets
def test_dry_run_with_load_prints_the_statistics(monkeypatch, capsys):
    import sounddevice as sd

    monkeypatch.setattr(sd, "Stream", lambda **kwargs: pytest.fail("a dry run opens no stream"))
    monkeypatch.setattr(sd, "query_devices", lambda: pytest.fail("a dry run does not look at devices"))
    monkeypatch.setattr(probe_module, "REPORT_EVERY_S", 0.2)
    code = main(["--dry", "--load", "--minutes", "0.01", "--buffer", "128"])
    printed = capsys.readouterr().out
    assert code in (0, 2)  # the verdict depends on the machine; the report must be there
    assert "Итог без звуковой карты" in printed
    assert "сбоев звука (xruns) за всё время: 0" in printed
    assert "от вызова до вызова: 99 % — до" in printed and "(должно быть 2,67 мс)" in printed
    assert "буфер: 128 отсчётов = 2,67 мс" in printed
    assert "Пробник прошёл" in printed or "Пробник не прошёл" in printed
    assert "раньше времени" not in printed
    assert "пакетов «сервера» собрано" in printed


# --- fix round 1: late callbacks, a run cut short, the driver's buffer sizes ---------------------

PERIOD_NS = 2_666_667  # 128 frames at 48 kHz


class FakeClock:
    """perf_counter_ns that returns the given entry and exit times in turn."""

    def __init__(self, stamps):
        self.stamps = list(stamps)

    def __call__(self):
        return self.stamps.pop(0)


def test_callback_records_entry_to_entry_intervals_and_counts_late_ones():
    # Entries at 10 ms, then one period later, then 2 periods later (late), then half a period
    # later (catching up). Each callback works 0.4 ms.
    entries = [10_000_000]
    for gap in (PERIOD_NS, 2 * PERIOD_NS, PERIOD_NS // 2):
        entries.append(entries[-1] + gap)
    stamps = [t for entry in entries for t in (entry, entry + 400_000)]
    chain = FakeChain()
    chain.block = 128
    probe = Probe(chain, 128, 16, None, SR, FakeClock(stamps))
    indata = np.zeros((128, 2), dtype=np.float32)
    outdata = np.zeros((128, 2), dtype=np.float32)
    for _ in entries:
        probe.callback(indata, outdata, 128, None, None)

    assert probe.count == 4 and probe.gap_count == 3
    assert list(probe_module.ring_tail(probe.gaps_ns, probe.gap_count)) == [PERIOD_NS, 2 * PERIOD_NS, PERIOD_NS // 2]
    assert probe.max_gap_ns == 2 * PERIOD_NS
    assert probe.late == 1
    assert list(window(probe)) == [400_000] * 4

    stats = probe_module.probe_stats(probe, SR)
    assert stats.gap_max_ms == pytest.approx(5.3333, abs=1e-3)
    assert stats.late == 1
    # The working time alone would pass; the late callback must not.
    assert stats.p99_ms == pytest.approx(0.4)
    assert stats.verdict.startswith("Пробник не прошёл") and "опозданий: 1" in stats.verdict
    assert "4,00 мс" in stats.verdict and "2,67 мс" in stats.verdict


def test_interval_statistics_from_a_synthetic_ring():
    gaps = np.full(1000, PERIOD_NS, dtype=np.int64)
    gaps[:20] = 4_100_000  # 2 % of the intervals at 4.1 ms: over 1.5 periods (4.0 ms)
    gaps[20:30] = 3_900_000  # long, but not late
    assert probe_module.late_count(gaps, 128, SR) == 20
    assert probe_module.late_count(gaps, 256, SR) == 0
    quick = np.full(1000, 400_000, dtype=np.int64)
    stats = stats_of(quick, 1001, 0, 500_000, 128, SR, gaps_ns=gaps, max_gap_ns=4_100_000, late=20)
    assert stats.gap_p99_ms == pytest.approx(4.1, abs=1e-6)
    assert stats.gap_max_ms == pytest.approx(4.1)
    assert stats.late == 20 and "опозданий: 20" in stats.verdict

    on_time = stats_of(quick, 1001, 0, 500_000, 128, SR, gaps_ns=np.full(1000, PERIOD_NS), max_gap_ns=PERIOD_NS)
    assert on_time.gap_p99_ms == pytest.approx(2.6667, abs=1e-3)
    assert on_time.verdict == "Пробник прошёл"


def test_ring_tail_after_the_gap_ring_wraps():
    ring = np.array([5, 6, 3, 4], dtype=np.int64)  # written 6 times: 1..6
    assert list(probe_module.ring_tail(ring, 6)) == [3, 4, 5, 6]
    assert list(probe_module.ring_tail(ring, 6, 3)) == [4, 5, 6]
    assert list(probe_module.ring_tail(ring, 0)) == []


def test_stats_problems_for_an_early_stop_and_odd_blocks():
    quick = np.full(100, 400_000, dtype=np.int64)
    stopped = stats_of(quick, 100, 0, 500_000, 128, SR, stopped="звук остановился раньше времени: вызовов 100 из 45000")
    assert stopped.verdict.startswith("Пробник не прошёл: звук остановился раньше времени")
    odd = stats_of(quick, 100, 0, 500_000, 128, SR, odd_blocks=2)
    assert "буферов не того размера: 2" in odd.verdict


def test_early_stop_text():
    chain = FakeChain()
    chain.block = 128
    probe = Probe(chain, 128, 16)
    info = probe_module.RunInfo()
    probe.count = 45000
    assert probe_module.early_stop_text(probe, info, 120, SR) == ""
    probe.count = 44500  # a slow start and clock drift are not an early stop
    assert probe_module.early_stop_text(probe, info, 120, SR) == ""
    probe.count = 1100
    assert "вызовов 1100 из 45000" in probe_module.early_stop_text(probe, info, 120, SR)
    info.interrupted = True  # Ctrl+C is the user's own choice
    assert probe_module.early_stop_text(probe, info, 120, SR) == ""
    info.stopped = "звук остановился раньше времени: через 3,0 с из 120,0 с"
    assert probe_module.early_stop_text(probe, info, 120, SR) == info.stopped
    probe.error = RuntimeError("Движок усилителя остановился.")
    text = probe_module.early_stop_text(probe, info, 120, SR)
    assert "расчёт сломался на вызове 1101" in text and "Движок усилителя остановился." in text


class BreakingChain:
    """A chain whose amp traps on the fifth block after the warm-up."""

    class Cab:
        def reset(self):
            pass

    def __init__(self, block, fail_after=None):
        self.block = block
        self.cab = self.Cab()
        self.calls = 0
        self.fail_after = fail_after
        self.armed = False

    def process(self, x, out):
        if self.armed:
            self.calls += 1
            if self.fail_after is not None and self.calls > self.fail_after:
                raise RuntimeError("Движок усилителя остановился.")
        np.multiply(x, 0.5, out=out)


def arm_after_warm_up(monkeypatch):
    real = probe_module.warm_up

    def warm(probe, sample_rate):
        real(probe, sample_rate)
        probe.chain.armed = True

    monkeypatch.setattr(probe_module, "warm_up", warm)


def test_dry_run_with_a_failing_callback_does_not_pass(monkeypatch, capsys):
    monkeypatch.setattr(probe_module, "Chain", lambda preset, block, sr: BreakingChain(block, fail_after=4))
    arm_after_warm_up(monkeypatch)
    code = main(["--dry", "--minutes", "0.01"])
    printed = capsys.readouterr().out
    assert code == 1
    assert "Пробник не прошёл: расчёт сломался на вызове 5, и звук остановился: Движок усилителя остановился." in printed
    assert "Пробник прошёл" not in printed
    assert "звуковая карта не запустилась" not in printed


class FakeStream:
    """Stands in for sounddevice.Stream: plays `blocks` callbacks from a thread, then goes quiet."""

    blocks = 0
    fail = False

    def __init__(self, **kwargs):
        import threading

        self.callback = kwargs["callback"]
        self.blocksize = kwargs["blocksize"]
        self.latency = (0.0082, 0.005)
        self.cpu_load = 0.37
        self.active = True
        self.opened_with = kwargs
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        indata = np.zeros((self.blocksize, 2), dtype=np.float32)
        outdata = np.zeros((self.blocksize, 2), dtype=np.float32)
        try:
            for _ in range(type(self).blocks):
                self.callback(indata, outdata, self.blocksize, None, None)
        except Exception:
            pass  # sounddevice prints the traceback and aborts the stream
        self.active = False

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._thread.join(timeout=2)
        return False


def fake_card(monkeypatch, blocks, sizes=(64, 2048, 256, -1)):
    import sounddevice as sd

    FakeStream.blocks = blocks
    monkeypatch.setattr(sd, "query_devices", lambda: [dev("M-Audio M-Track Solo and Duo...", 2, 2, 2)])
    monkeypatch.setattr(sd, "query_hostapis", lambda: APIS)
    monkeypatch.setattr(sd, "Stream", FakeStream)
    # Never ask the real driver from a test.
    monkeypatch.setattr(probe_module, "asio_buffer_sizes", lambda sd_module, device: sizes)
    monkeypatch.setattr(probe_module, "POLL_S", 0.02)


def test_stream_that_stops_by_itself_does_not_pass(monkeypatch, capsys):
    # The driver stops the stream after 30 blocks of a 3-second run: no xruns, quick callbacks.
    fake_card(monkeypatch, blocks=30)
    monkeypatch.setattr(probe_module, "Chain", lambda preset, block, sr: BreakingChain(block))
    code = main(["--minutes", "0.05"])
    printed = capsys.readouterr().out
    assert code == 1
    assert "Пробник не прошёл: звук остановился раньше времени: через" in printed
    assert "Пробник прошёл" not in printed
    assert "Буферы драйвера ASIO: от 64 до 2048 отсчётов, сам драйвер выбирает 256, размеры — степени двойки." in printed
    assert "поставь 128 в панели драйвера" in printed
    assert "Блок потока: 128 отсчётов" in printed
    assert "задержка драйвера: вход 8,2 мс, выход 5,0 мс" in printed
    assert "загрузка звукового потока по счёту драйвера: 37 %" in printed


def test_stream_with_a_failing_callback_names_the_failure(monkeypatch, capsys):
    fake_card(monkeypatch, blocks=30, sizes=None)
    monkeypatch.setattr(probe_module, "Chain", lambda preset, block, sr: BreakingChain(block, fail_after=9))
    arm_after_warm_up(monkeypatch)
    code = main(["--minutes", "0.05"])
    printed = capsys.readouterr().out
    assert code == 1
    assert "расчёт сломался на вызове 10" in printed and "Пробник прошёл" not in printed
    assert "Буферы драйвера ASIO" not in printed


def test_asio_buffer_sizes_through_ctypes_and_when_unknown():
    import ctypes
    from types import SimpleNamespace

    asked = {}

    class Function:
        def __call__(self, device, low, high, preferred, step):
            asked["device"] = device
            for pointer, value in ((low, 64), (high, 2048), (preferred, 256), (step, -1)):
                ctypes.cast(pointer, ctypes.POINTER(ctypes.c_long))[0] = value
            return 0

    class Refusing(Function):
        def __call__(self, *args):
            return -9996  # paInvalidDevice: not an ASIO device

    sd = SimpleNamespace(_lib=SimpleNamespace(), _libname="portaudio-asio.dll")
    library = SimpleNamespace(PaAsio_GetAvailableBufferSizes=Function())
    assert probe_module.asio_buffer_sizes(sd, 19, lambda name: library) == (64, 2048, 256, -1)
    assert asked["device"] == 19

    refusing = SimpleNamespace(PaAsio_GetAvailableBufferSizes=Refusing())
    assert probe_module.asio_buffer_sizes(sd, 19, lambda name: refusing) is None
    assert probe_module.asio_buffer_sizes(sd, 19, lambda name: SimpleNamespace()) is None  # no such export

    def broken(name):
        raise OSError("no such library")

    assert probe_module.asio_buffer_sizes(sd, 19, broken) is None


def test_buffer_sizes_text():
    text = probe_module.buffer_sizes_text((128, 128, 128, 0), 128)
    assert text == "Буферы драйвера ASIO: от 128 до 128 отсчётов, сам драйвер выбирает 128."
    assert "шаг 32" in probe_module.buffer_sizes_text((32, 1024, 256, 32), 128)
