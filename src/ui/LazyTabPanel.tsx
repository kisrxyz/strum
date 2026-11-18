import { lazy, Suspense } from 'react';
import { L } from '../i18n';
import type { Analysis, Song } from '../song/types';

// alphaTab is big: it loads only when a tab is shown, not with the app.
const TabPanel = lazy(() => import('./TabPanel').then((m) => ({ default: m.TabPanel })));

export function LazyTabPanel(props: { song: Song; analysis: Analysis | null }) {
  return (
    <Suspense fallback={<div className="empty"><p className="empty__text">{L().songUi.tabOpening}</p></div>}>
      <TabPanel {...props} />
    </Suspense>
  );
}
