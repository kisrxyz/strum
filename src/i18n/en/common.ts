// Words shared by every screen. Only these: anything else lives in the screen's own namespace.
export const common = {
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
  units: {
    db: 'dB',
    ms: 'ms',
    hz: 'Hz',
    pct: (n: number) => `${n}%`,
  },
};
