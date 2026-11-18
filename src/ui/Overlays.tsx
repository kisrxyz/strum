import { Minus, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLang } from '../i18n/useLang';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';
import { Tuner } from './Tuner';

/** The tuner over any screen (T): the note, the needle, the six strings; the A4 reference under it. */
export function BigTuner() {
  const open = useRuntime((s) => s.bigTuner);
  const a4 = useSettings((s) => s.a4);
  const setA4 = useSettings((s) => s.setA4);
  const t = useLang();
  if (!open) return null;
  const close = () => useRuntime.getState().patch({ bigTuner: false });
  return (
    <div className="bigtuner" role="dialog" aria-label={t.shell.tuner} onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="bigtuner__box">
        <button type="button" className="iconbtn bigtuner__close" aria-label={t.common.close} title={t.shell.bigTunerClose} onClick={close}>
          <X />
        </button>
        <Tuner />
        <div className="bigtuner__foot">
          <span className="bigtuner__a4">
            {t.input.a4}
            <span className="stepper">
              <button type="button" aria-label={t.input.lower} title={t.input.lowerTip} onClick={() => setA4(a4 - 1)}>
                <Minus size={14} />
              </button>
              <span className="stepper__value">
                {a4} {t.common.units.hz}
              </span>
              <button type="button" aria-label={t.input.higher} title={t.input.higherTip} onClick={() => setA4(a4 + 1)}>
                <Plus size={14} />
              </button>
            </span>
          </span>
          <span>{t.shell.bigTunerClose}</span>
        </div>
      </div>
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
    <div key={toast.id} className={`toast toast--${toast.tone}`} role="status">
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
