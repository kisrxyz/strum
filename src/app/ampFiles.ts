// Adding the user's own amp models (.nam) and cabinets (.wav): dropped into the window (App.tsx) or
// picked with the button on the amp screen. Each goes straight into the current preset.
import { addUserAsset, listUserAssets } from '../audio/assets';
import { L } from '../i18n';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';

export async function addAmpFiles(files: File[]): Promise<void> {
  const rt = useRuntime.getState();
  for (const file of files) {
    try {
      const info = await addUserAsset(file);
      rt.patch({ userAssets: await listUserAssets() });
      const st = useSettings.getState();
      st.updatePreset(st.presetIndex, info.kind === 'model' ? { amp: { model: info.id } } : { cab: info.id });
      rt.showToast(info.kind === 'model' ? L().shell.modelAdded(info.name) : L().shell.cabinetAdded(info.name));
    } catch (error) {
      rt.showToast(error instanceof Error ? error.message : L().shell.fileRejected, 'warn');
    }
  }
}
