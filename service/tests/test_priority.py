"""The song service gives way to the guitar: its process runs below normal priority."""

import os
import sys

from kv_service.priority import lower_priority


def test_lower_priority_lowers_this_process():
    assert lower_priority() is True
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.GetPriorityClass.argtypes = [ctypes.c_void_p]
        BELOW_NORMAL = 0x4000
        assert kernel32.GetPriorityClass(kernel32.GetCurrentProcess()) == BELOW_NORMAL
        # Back to normal: the test runner shares the process.
        kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x20)
    else:
        assert os.nice(0) > 0
