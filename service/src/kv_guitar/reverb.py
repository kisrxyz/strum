"""The reverb and the cabinet: convolution with a long impulse response, no latency, no spikes.

A 3 s reverb is 144 000 taps. Cut into pieces of one block (as `PartitionedConvolver` does) that
would be 1 125 spectra to multiply every 2.7 ms — far too much. So the response is cut in three
zones (Gardner's non-uniform partitioning), for a block of b samples:

    taps   0 … 6b    pieces of b      computed at once, inside the block that needs them
    taps  6b … 30b   pieces of 4b     computed over the next 4 blocks
    taps 30b … end   pieces of 16b    computed over the next 16 blocks

A zone with pieces of N samples starts at tap 2N − 2b or later: by the time its first output
sample is due, the work on the input piece that makes it is already done, however it was spread.
Nothing is late, so the convolution adds no delay of its own. The work of the two big zones is
spread over the callbacks in between (one transform, or a share of the multiply-adds, each), so no
callback carries a whole big transform on top of everything else. All of it runs inside the audio
callback: there is no helper thread to fight over the interpreter.

The first zone runs in every block, so it is one compiled kernel with its own small FFT: called
from Python, numpy's transforms cost more in the call than in the work at this size. The big
zones use numpy's (a few calls per 16 blocks).

One or two channels: the cabinet is mono; the reverb has two inputs (the chain is stereo after the
chorus), where a mono response serves both and a stereo one is left ⊛ left, right ⊛ right — what a
ConvolverNode does.
"""

from __future__ import annotations

import copy
import math

import numpy as np
from numba import njit

from .dsp import zeros

# The later zones: (piece size, first tap), in blocks. The first zone is pieces of one block.
LATE_ZONES = ((4, 6), (16, 30))


def convolver_normalization(ir: np.ndarray, sample_rate: int) -> float:
    """The gain a ConvolverNode with `normalize = true` gives its buffer (Web Audio, «Convolver
    normalization»): equal loudness whatever the response's own level."""
    x = np.asarray(ir, dtype=np.float64)
    channels = x.shape[1] if x.ndim == 2 else 1
    power = math.sqrt(float(np.mean(np.square(x)))) if x.size else 0.0
    if not math.isfinite(power) or power < 0.000125:
        power = 0.000125
    scale = 1.0 / power * 0.00125 * (44100.0 / sample_rate)
    if channels == 4:
        scale *= 0.5
    return scale


@njit(cache=True, fastmath=True)
def _fft(a, twiddles):
    """In-place radix-2 FFT of `a` (complex, already in bit-reversed order)."""
    n = a.shape[0]
    size = 2
    while size <= n:
        half = size >> 1
        step = n // size
        for start in range(0, n, size):
            for j in range(half):
                w = twiddles[j * step]
                u = a[start + j]
                v = a[start + j + half] * w
                a[start + j] = u + v
                a[start + j + half] = u - v
        size <<= 1


@njit(cache=True, fastmath=True)
def _head(send, inbuf, h, history, newest, twiddles, order, scratch, acc, ring, t, late_a, at_a, late_b, at_b):
    """The first zone, whole: this block in, its part of the answer added to the ring.

    Also copies the block into the input buffers of the two later zones.
    """
    channels = send.shape[0]
    b = send.shape[1]
    n = 2 * b
    pieces = history.shape[0]
    ir_channels = h.shape[1]
    mask = ring.shape[1] - 1
    scale = np.float32(1.0 / n)
    for ch in range(channels):
        for i in range(b):
            v = send[ch, i]
            inbuf[ch, b + i] = v
            late_a[ch, at_a + i] = v
            late_b[ch, at_b + i] = v
        # The last two blocks → their spectrum (the older block makes the wrap-around harmless).
        for k in range(n):
            scratch[k] = inbuf[ch, order[k]]
        _fft(scratch, twiddles)
        for k in range(b + 1):
            history[newest, ch, k] = scratch[k]
        for i in range(b):
            inbuf[ch, i] = inbuf[ch, b + i]

        hc = ch if ir_channels > 1 else 0
        for k in range(b + 1):
            acc[k] = 0.0
        for p in range(pieces):
            q = newest + p
            if q >= pieces:
                q -= pieces
            for k in range(b + 1):
                acc[k] += history[q, ch, k] * h[p, hc, k]

        # Back to time: for a real signal, the real part of the forward transform of the
        # conjugated spectrum, over n. Only the second half is free of wrap-around.
        for k in range(b + 1):
            scratch[order[k]] = np.conj(acc[k])
        for k in range(1, b):
            scratch[order[n - k]] = acc[k]
        _fft(scratch, twiddles)
        for i in range(b):
            ring[ch, (t + i) & mask] += scratch[b + i].real * scale


@njit(cache=True)
def _snapshot(inbuf, frame):
    """frame ← the last two pieces; the newer one becomes the older one of the next frame."""
    half = inbuf.shape[1] // 2
    for ch in range(inbuf.shape[0]):
        for i in range(2 * half):
            frame[ch, i] = inbuf[ch, i]
        for i in range(half):
            inbuf[ch, i] = inbuf[ch, half + i]


@njit(cache=True, fastmath=True)
def _multiply_add(history, newest, h, acc, first, last, clear):
    """acc += Σ history[newest + p] · h[p] for the pieces first ≤ p < last."""
    pieces = history.shape[0]
    channels = history.shape[1]
    bins = history.shape[2]
    ir_channels = h.shape[1]
    if clear:
        for ch in range(channels):
            for k in range(bins):
                acc[ch, k] = 0.0
    for p in range(first, last):
        q = newest + p
        if q >= pieces:
            q -= pieces
        for ch in range(channels):
            hc = ch if ir_channels > 1 else 0
            for k in range(bins):
                acc[ch, k] += history[q, ch, k] * h[p, hc, k]


@njit(cache=True)
def _ring_add(ring, at, time):
    """ring[at …] += the valid half of an inverse transform."""
    mask = ring.shape[1] - 1
    half = time.shape[1] // 2
    for ch in range(ring.shape[0]):
        for i in range(half):
            ring[ch, (at + i) & mask] += time[ch, half + i]


@njit(cache=True)
def _ring_take(ring, at, wet):
    mask = ring.shape[1] - 1
    for ch in range(ring.shape[0]):
        for i in range(wet.shape[1]):
            j = (at + i) & mask
            wet[ch, i] = ring[ch, j]
            ring[ch, j] = 0.0


def _spectra(taps: np.ndarray, size: int) -> np.ndarray:
    """(pieces, response channels, size + 1): the response in pieces of `size`, each padded to 2·size."""
    pieces = max(1, -(-taps.shape[0] // size))
    channels = taps.shape[1]
    out = np.zeros((pieces, channels, size + 1), dtype=np.complex64)
    padded = np.zeros((channels, 2 * size), dtype=np.float32)
    # One piece at a time: many short calls, so a loader thread never keeps the interpreter long.
    for p in range(pieces):
        piece = taps[p * size : (p + 1) * size]
        padded[:] = 0
        padded[:, : len(piece)] = piece.T
        np.fft.rfft(padded, axis=1, out=out[p])
    return out


# Zeros that are really there (np.zeros leaves the pages to be made on first touch, which would
# then happen in the audio callback): see `dsp.zeros`.
_zeros = zeros


class _LateZone:
    """A later stretch of the response, in pieces of `size` samples, its work spread over `slots` blocks."""

    def __init__(self, taps: np.ndarray, size: int, offset: int, block: int, channels: int) -> None:
        self.size = size
        self.offset = offset
        self.channels = channels
        self.slots = size // block
        self.h = _spectra(taps, size)
        self.pieces = self.h.shape[0]
        # The multiply-adds are cut into this many shares.
        self.shares = self.slots - 2 if self.slots < 16 else self.slots - 4
        self._new_state()

    def _new_state(self) -> None:
        size = self.size
        channels = self.channels
        bins = size + 1
        self.history = _zeros((self.pieces, channels, bins), np.complex64)
        self.newest = 0
        self.inbuf = _zeros((channels, 2 * size), np.float32)
        self.frame = _zeros((channels, 2 * size), np.float32)
        self.acc = _zeros((channels, bins), np.complex64)
        self.time = _zeros((channels, 2 * size), np.float32)
        self.filled = 0
        # Which share of the current piece's work is next; −1: nothing to do.
        self.slot = -1
        self.out_at = 0

    def clone(self) -> _LateZone:
        other = copy.copy(self)  # shares the spectra
        other._new_state()
        return other

    def reset(self) -> None:
        self.history[:] = 0
        self.inbuf[:] = 0
        self.filled = 0
        self.slot = -1

    def start(self, out_at: int) -> None:
        _snapshot(self.inbuf, self.frame)
        self.filled = 0
        self.slot = 0
        self.out_at = out_at
        newest = self.newest - 1
        self.newest = newest if newest >= 0 else self.pieces - 1

    def _share(self, index: int) -> None:
        first = index * self.pieces // self.shares
        last = (index + 1) * self.pieces // self.shares
        _multiply_add(self.history, self.newest, self.h, self.acc, first, last, index == 0)

    def work(self, ring: np.ndarray) -> None:
        """One block's share of the work on the piece that filled up last."""
        slot = self.slot
        slots = self.slots
        n = 2 * self.size
        if slots < 16:
            if slot == 0:
                np.fft.rfft(self.frame, axis=1, out=self.history[self.newest])
            elif slot < slots - 1:
                self._share(slot - 1)
            else:
                np.fft.irfft(self.acc, n=n, axis=1, out=self.time)
                _ring_add(ring, self.out_at, self.time)
        else:
            # The big transforms one channel at a time: four small bumps instead of two big ones.
            if slot < 2:
                if slot < self.channels:
                    np.fft.rfft(self.frame[slot], out=self.history[self.newest, slot])
            elif slot < slots - 2:
                self._share(slot - 2)
            else:
                ch = slot - (slots - 2)
                if ch < self.channels:
                    np.fft.irfft(self.acc[ch], n=n, out=self.time[ch])
                if ch == 1:
                    _ring_add(ring, self.out_at, self.time)
        slot += 1
        self.slot = slot if slot < slots else -1


class ZonedConvolver:
    """`process` one block at a time; nothing is allocated after the constructor.

    `channels` inputs (and as many outputs); the response is (taps,) or (taps, 1 or `channels`).
    """

    def __init__(self, ir: np.ndarray, block: int, channels: int = 2) -> None:
        if channels not in (1, 2):
            raise ValueError("one or two channels")
        if block < 4 or block & (block - 1):
            raise ValueError("block must be a power of two")
        taps = np.asarray(ir, dtype=np.float32)
        if taps.ndim == 1:
            taps = taps[:, None]
        taps = taps[:, :channels]
        if not len(taps):
            taps = np.zeros((1, 1), dtype=np.float32)
        self.block = block
        self.channels = channels
        self.length = len(taps)

        # The first zone.
        n = 2 * block
        self._h = _spectra(taps[: LATE_ZONES[0][1] * block], block)
        self._twiddles = np.exp(-2j * np.pi * np.arange(block) / n).astype(np.complex64)
        bits = n.bit_length() - 1
        self._order = np.array([int(format(k, f"0{bits}b")[::-1], 2) for k in range(n)], dtype=np.int64)

        self.late: list[_LateZone] = []
        for index, (size, offset) in enumerate(LATE_ZONES):
            start = offset * block
            if start >= len(taps):
                break
            end = LATE_ZONES[index + 1][1] * block if index + 1 < len(LATE_ZONES) else len(taps)
            self.late.append(_LateZone(taps[start:end], size * block, start, block, channels))
        self._period = self.late[-1].size if self.late else block
        # Blocks of silence after which every state is zero again.
        self._flush_blocks = (self.length + 4 * self._period) // block + 2
        self._new_state()

    def _new_state(self) -> None:
        block = self.block
        channels = self.channels
        self._history = _zeros((self._h.shape[0], channels, block + 1), np.complex64)
        self._newest = 0
        self._inbuf = _zeros((channels, 2 * block), np.float32)
        self._scratch = _zeros((2 * block,), np.complex64)
        self._acc = _zeros((block + 1,), np.complex64)
        # Where the kernel copies the input for the later zones (or nowhere that matters).
        spare = _zeros((channels, block), np.float32)
        self._late_in = [zone.inbuf for zone in self.late] + [spare] * (2 - len(self.late))
        self._ring = _zeros((channels, 4 * LATE_ZONES[-1][0] * block), np.float32)
        self._t = 0
        self._quiet = self._flush_blocks
        self.idle = True

    def clone(self) -> ZonedConvolver:
        """A fresh convolver for the same response: it shares the spectra (never written after the
        constructor) and has its own, silent, state. Cheap: no file, no transform."""
        other = copy.copy(self)
        other.late = [zone.clone() for zone in self.late]
        other._new_state()
        return other

    def reset(self) -> None:
        self._history[:] = 0
        self._inbuf[:] = 0
        for zone in self.late:
            zone.reset()
        self._ring[:] = 0
        self._t = 0
        self._quiet = self._flush_blocks
        self.idle = True

    def align(self, blocks: int) -> None:
        """Before the first block: where in their pieces the big zones start.

        Two convolvers in one chain (cabinet, reverb) given block counts that differ by a few
        do their big transforms in different callbacks.
        """
        if self._t:
            raise RuntimeError("align() comes before the first block")
        for zone in self.late:
            zone.filled = (blocks * self.block) % zone.size

    def process(self, send: np.ndarray, wet: np.ndarray, silent: bool = False) -> None:
        """`send`, `wet`: (channels, block) float32, C-contiguous (may be the same array).
        `silent`: `send` is all zeros.

        After enough silence for the tail to end the convolver rests (no work at all) until sound
        comes back; it stops and starts on a boundary of its biggest piece, with every state zero.
        """
        late = self.late
        if silent:
            if self.idle:
                wet.fill(0)
                return
            self._quiet += 1
            if self._quiet >= self._flush_blocks and (not late or late[-1].filled == 0):
                self.idle = True
                wet.fill(0)
                return
        else:
            self._quiet = 0
            self.idle = False
        block = self.block
        t = self._t
        ring = self._ring
        newest = self._newest - 1
        if newest < 0:
            newest = self._history.shape[0] - 1
        self._newest = newest
        at_a = late[0].size + late[0].filled if late else 0
        at_b = late[1].size + late[1].filled if len(late) > 1 else 0
        _head(
            send, self._inbuf, self._h, self._history, newest, self._twiddles, self._order, self._scratch,
            self._acc, ring, t, self._late_in[0], at_a, self._late_in[1], at_b,
        )  # fmt: skip
        for zone in late:
            zone.filled += block
            if zone.filled == zone.size:
                # This piece began at t + block − size; its part of the response starts `offset` later.
                zone.start(t + block - zone.size + zone.offset)
            if zone.slot >= 0:
                zone.work(ring)
        _ring_take(ring, t, wet)
        self._t = t + block


class ReverbConvolver(ZonedConvolver):
    """The reverb: two channels in, two out."""

    def __init__(self, ir: np.ndarray, block: int) -> None:
        super().__init__(ir, block, 2)


class CabinetConvolver(ZonedConvolver):
    """The cabinet: the same convolution as `PartitionedConvolver`, in about half the time.

    `process` takes (1, block) arrays.
    """

    def __init__(self, ir: np.ndarray, block: int) -> None:
        super().__init__(np.asarray(ir, dtype=np.float32).reshape(-1), block, 1)


def warm_up(block: int = 128) -> None:
    """Compiles the kernels and lets numpy plan its transforms, for both channel counts."""
    for channels in (1, 2):
        conv = ZonedConvolver(np.ones((block * 40, channels), dtype=np.float32), block, channels)
        buf = np.ones((channels, block), dtype=np.float32)
        for _ in range(40):
            conv.process(buf, buf)
