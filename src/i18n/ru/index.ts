import type { Dict } from '../dict';
import { actions } from './actions';
import { amp } from './amp';
import { common } from './common';
import { input } from './input';
import { keys } from './keys';
import { library } from './library';
import { sections } from './sections';
import { service } from './service';
import { shell } from './shell';
import { songUi } from './songUi';

export const ru: Dict = { common, service, shell, library, amp, input, songUi, actions, keys, sections };
