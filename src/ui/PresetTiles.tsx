import { assetName } from '../audio/assets';
import { withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { presetName } from '../state/presets';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';

/** The presets as a list on the left of the amp: its number (the key that picks it), its name, its amp. */
export function PresetList() {
  const presets = useSettings((s) => s.presets);
  const active = useSettings((s) => s.presetIndex);
  const select = useSettings((s) => s.selectPreset);
  const userAssets = useRuntime((s) => s.userAssets);
  const t = useLang();

  return (
    <nav className="presets" aria-label={t.amp.presetsLabel}>
      {presets.map((p, i) => {
        const name = presetName(p, t.amp.presets);
        return (
          <button
            key={p.id}
            type="button"
            className="preset"
            aria-pressed={i === active}
            title={`${withKey(name, String(i + 1))} · ${withKey(t.amp.flipPresets, '← / →')}`}
            onClick={() => select(i)}
          >
            <span className="preset__no num">{i + 1}</span>
            <span className="preset__words">
              <span className="preset__name">{name}</span>
              <span className="preset__amp">{assetName(p.amp.model, userAssets)}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
