import type { KeybindingActionId } from '../../../shared/keybindings/types'
import {
  CLIENT_PROFILE_SWITCH_ACTION_ID,
  CLIENT_PROFILE_SWITCHER_OPEN_EVENT
} from '../../../shared/aiborg/client-profile-keybindings'

type ClaimShortcut = (actionId: KeybindingActionId, run: () => void) => boolean

/** Map entry for createAppCommandHandlers (H43): the chip owns the menu and listens for the event. */
export function clientProfileSwitchCommandEntry(
  claim: ClaimShortcut
): [KeybindingActionId, () => boolean] {
  return [
    CLIENT_PROFILE_SWITCH_ACTION_ID,
    () =>
      claim(CLIENT_PROFILE_SWITCH_ACTION_ID, () =>
        window.dispatchEvent(new Event(CLIENT_PROFILE_SWITCHER_OPEN_EVENT))
      )
  ]
}
