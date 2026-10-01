import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'
import { switchClientProfile, useClientProfileStore } from './client-profile-store'

const OPEN_FLOATING_PANEL_SELECTOR = '[data-floating-terminal-panel][aria-hidden="false"]'

export type SetupTerminalResult = 'started' | 'floating-terminal-disabled'

/**
 * Runs a setup command (gh auth login, codex login, ...) in a floating terminal. Floating terminals
 * are pinned to the active profile at spawn, so the profile is activated first; main binds the PTY.
 */
export async function runInClientProfileSetupTerminal(
  profileId: string,
  command: string
): Promise<SetupTerminalResult> {
  const store = useAppStore.getState()
  if (store.settings?.floatingTerminalEnabled !== true) {
    return 'floating-terminal-disabled'
  }
  if (useClientProfileStore.getState().snapshot?.activeProfileId !== profileId) {
    await switchClientProfile(profileId)
  }
  const tab = store.createTab(
    FLOATING_TERMINAL_WORKTREE_ID,
    store.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID],
    undefined,
    { pendingStartup: { command } }
  )
  if (!document.querySelector(OPEN_FLOATING_PANEL_SELECTOR)) {
    window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
  }
  focusTerminalTabSurface(tab.id)
  return 'started'
}
