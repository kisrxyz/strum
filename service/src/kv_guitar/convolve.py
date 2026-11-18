"""The cabinet: convolution with an impulse response, block by block, with no added latency.

Uniform partitioned overlap-save: the IR is cut into pieces of one block, each piece's spectrum
is kept, and every block costs one forward FFT of 2·block, one multiply-and-sum over the pieces
and one inverse FFT. Nothing is allocated after the constructor.
"""

from __future__ import annotations

import numpy as np


class PartitionedConvolver:
    def __init__(self, ir: np.ndarray, block: int) -> None:
        taps = np.asarray(ir, dtype=np.float32).reshape(-1)
        if block <= 0:
            raise ValueError("block must be positive")
        if not len(taps):
            taps = np.zeros(1, dtype=np.float32)
        self.block = block
        parts = -(-len(taps) // block)
        self._parts = parts
        bins = block + 1

        padded = np.zeros((parts, 2 * block), dtype=np.float32)
        for p in range(parts):
            piece = taps[p * block : (p + 1) * block]
            padded[p, : len(piece)] = piece
        self._h = np.fft.rfft(padded, axis=1).astype(np.complex64)

        # The input spectra, newest first. Stored twice, so that the last `parts` of them are
        # always one contiguous slice [pos, pos + parts) and no index juggling is needed.
        self._x = np.zeros((2 * parts, bins), dtype=np.complex64)
        self._pos = 0
        self._input = np.zeros(2 * block, dtype=np.float32)
        self._spectrum = np.zeros(bins, dtype=np.complex64)
        self._products = np.zeros((parts, bins), dtype=np.complex64)
        self._sum = np.zeros(bins, dtype=np.complex64)
        self._time = np.zeros(2 * block, dtype=np.float32)

    def process(self, x: np.ndarray, out: np.ndarray) -> None:
        """Convolves one block: `x` and `out` are float32 of exactly `block` samples (may be the same array)."""
        block = self.block
        if len(x) != block or len(out) != block:
            raise ValueError(f"the convolver works in blocks of {block} samples")
        buf = self._input
        buf[:block] = buf[block:]
        buf[block:] = x
        np.fft.rfft(buf, out=self._spectrum)

        parts = self._parts
        pos = self._pos - 1
        if pos < 0:
            pos += parts
        self._pos = pos
        self._x[pos] = self._spectrum
        self._x[pos + parts] = self._spectrum

        np.multiply(self._x[pos : pos + parts], self._h, out=self._products)
        np.sum(self._products, axis=0, out=self._sum)
        np.fft.irfft(self._sum, n=2 * block, out=self._time)
        # The first half is time-aliased, the second half is this block's output.
        out[:] = self._time[block:]

    def reset(self) -> None:
        self._x[:] = 0
        self._input[:] = 0
