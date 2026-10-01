import type { KeybindingDefinition } from '../keybindings/types'
import { platformBindings } from '../keybindings/definitions-support'

import {
  CLIENT_PROFILE_SWITCH_ACTION_ID,
  type AiborgKeybindingActionId
} from './client-profile-keybinding-ids'

export { CLIENT_PROFILE_SWITCH_ACTION_ID, type AiborgKeybindingActionId }

/** The renderer opens the chip menu on this window event (H43 handler). */
export const CLIENT_PROFILE_SWITCHER_OPEN_EVENT = 'aiborg:client-profile-switcher-open'

export type AiborgKeybindingDefinition = Omit<KeybindingDefinition, 'id'> & {
  id: AiborgKeybindingActionId
}

/** Merged into KEYBINDING_DEFINITIONS (H43); `Mod+Shift+P` is unused upstream. */
export const AIBORG_KEYBINDING_DEFINITIONS: readonly AiborgKeybindingDefinition[] = [
  {
    id: CLIENT_PROFILE_SWITCH_ACTION_ID,
    title: 'Switch client profile',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'global', 'client', 'profile', 'switch', 'aiborg'],
    defaultBindings: platformBindings(['Mod+Shift+P'])
  }
]
