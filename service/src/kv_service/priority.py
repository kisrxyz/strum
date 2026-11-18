"""The song service gives way to the guitar engine: separating, analysing and hearing words run on
every core of a machine without a graphics card, and at normal priority they make the guitar click.
Below normal, Windows gives the engine's audio process the processor first."""

from __future__ import annotations

import os
import sys

# Windows priority classes (winbase.h).
_BELOW_NORMAL = 0x4000
_POSIX_NICENESS = 5


def lower_priority() -> bool:
    """Lowers this process below normal priority. True when it worked."""
    try:
        if sys.platform == "win32":
            import ctypes

            kernel32 = ctypes.windll.kernel32
            kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            return bool(kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), _BELOW_NORMAL))
        os.nice(_POSIX_NICENESS)
        return True
    except (OSError, AttributeError):
        return False
