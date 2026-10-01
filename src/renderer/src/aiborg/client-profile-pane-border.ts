import { useLayoutEffect } from 'react'
import { useAppStore } from '@/store'
import { retainClientProfileSync, useClientProfileStore } from './client-profile-store'
import type { ClientProfilesState } from '../../../shared/aiborg/client-profile-types'

type BorderPane = { id: number; container: HTMLElement }

type PaneBorderController = {
  managerRef: { current: { getPanes: () => BorderPane[] } | null }
  paneTransportsRef: {
    current: Map<number, { getPtyId: () => string | null }>
  }
  paneCount: number
}

/** Paints each pane with the profile its PTY was spawned under (ptyBindings), never the active one. */
export function applyClientProfilePaneBorders(
  panes: readonly BorderPane[],
  ptyIdForPane: (paneId: number) => string | null,
  snapshot: ClientProfilesState | null
): void {
  for (const pane of panes) {
    const ptyId = ptyIdForPane(pane.id)
    const profileId = ptyId ? snapshot?.ptyBindings[ptyId] : undefined
    const color = profileId
      ? snapshot?.profiles.find((entry) => entry.id === profileId)?.profile?.color
      : undefined
    if (!profileId) {
      delete pane.container.dataset.aiborgProfile
      pane.container.style.removeProperty('--aiborg-pane-color')
      continue
    }
    pane.container.dataset.aiborgProfile = profileId
    if (color) {
      pane.container.style.setProperty('--aiborg-pane-color', color)
    } else {
      // A deleted or invalid profile keeps the attribute but no colour.
      pane.container.style.removeProperty('--aiborg-pane-color')
    }
  }
}

const ptyIdListeners = new Set<() => void>()
let stopPtyIdSubscription: (() => void) | null = null

// Why one shared app-store listener: TerminalPane's per-pane store listener budget is pinned.
function subscribeToPtyIdChanges(listener: () => void): () => void {
  ptyIdListeners.add(listener)
  stopPtyIdSubscription ??= useAppStore.subscribe((state, previous) => {
    if (state.ptyIdsByTabId !== previous.ptyIdsByTabId) {
      ptyIdListeners.forEach((notify) => notify())
    }
  })
  return () => {
    ptyIdListeners.delete(listener)
    if (ptyIdListeners.size === 0) {
      stopPtyIdSubscription?.()
      stopPtyIdSubscription = null
    }
  }
}

export function useClientProfilePaneBorder(controller: PaneBorderController): void {
  const { managerRef, paneTransportsRef, paneCount } = controller
  const snapshot = useClientProfileStore((s) => s.snapshot)

  useLayoutEffect(() => retainClientProfileSync(), [])

  useLayoutEffect(() => {
    const apply = (): void => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      applyClientProfilePaneBorders(
        manager.getPanes(),
        (paneId) => paneTransportsRef.current.get(paneId)?.getPtyId() ?? null,
        snapshot
      )
    }
    apply()
    // A pane's PTY id arrives after spawn, which is when ptyIdsByTabId changes.
    return subscribeToPtyIdChanges(apply)
  }, [managerRef, paneTransportsRef, snapshot, paneCount])
}
