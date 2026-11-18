// Words shared by every screen. Only these: anything else lives in the screen's own namespace.
export const common = {
  ok: 'OK',
  done: 'Done',
  cancel: 'Cancel',
  close: 'Close',
  delete: 'Delete',
  retry: 'Try again',
  reset: 'Reset',
  on: 'on',
  off: 'off',
  none: 'none',
  loading: 'Loading…',
  saving: 'Saving…',
  /** A dangerous action waits for a second press. */
  pressAgainToDelete: 'Press again to delete.',
  units: {
    db: 'dB',
    ms: 'ms',
    hz: 'Hz',
    khz: 'kHz',
    s: 's',
    pct: (n: number) => `${n}%`,
  },
};
