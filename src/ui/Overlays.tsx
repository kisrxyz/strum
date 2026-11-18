import { useEffect, useState } from 'react';
import { useLang } from '../i18n/useLang';
import { useRuntime } from '../state/runtime';
import { Tuner } from './Tuner';

export function BigTuner() {
  const open = useRuntime((s) => s.bigTuner);
  const t = useLang();
  if (!open) return null;
  return (
    <div className="bigtuner" role="dialog" aria-label={t.shell.bigTuner}>
      <Tuner size="big" />
      <p className="bigtuner__hint">{t.shell.bigTunerClose}</p>
    </div>
  );
}

export function ToastView() {
  const toast = useRuntime((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), toast.tone === 'warn' ? 6000 : 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast || !visible) return null;
  return (
    <div className={`toast toast--${toast.tone}`} role="status">
      {toast.text}
    </div>
  );
}

export function DropZone({ active }: { active: boolean }) {
  const t = useLang();
  if (!active) return null;
  return (
    <div className="dropzone" aria-hidden="true">
      {t.shell.dropZone}
    </div>
  );
}
