import { create } from 'zustand'
import type { ClientProfilesState } from '../../../shared/aiborg/client-profile-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  ensureRepoProfileResolved,
  findClientProfileIdForRepo,
  useClientProfileStore
} from './client-profile-store'

export type ClientProfileMismatch = {
  worktreeId: string
  repoProfileId: string
  activeProfileId: string | null
}

type MismatchState = {
  /** Mismatch the warning dialog should ask about next. */
  pending: ClientProfileMismatch | null
  /** Worktrees the user chose to open read-only this session. */
  readOnlyWorktreeIds: ReadonlySet<string>
}

export const useClientProfileMismatchStore = create<MismatchState>(() => ({
  pending: null,
  readOnlyWorktreeIds: new Set()
}))

export function findClientProfileMismatch(
  snapshot: ClientProfilesState | null,
  worktreeId: string | null,
  resolvedRepoProfiles: Record<string, string | null> = {}
): ClientProfileMismatch | null {
  if (!snapshot?.enabled || !worktreeId) {
    return null
  }
  const repoProfileId = findClientProfileIdForRepo(
    snapshot,
    getRepoIdFromWorktreeId(worktreeId),
    resolvedRepoProfiles
  )
  if (!repoProfileId || repoProfileId === snapshot.activeProfileId) {
    return null
  }
  return {
    worktreeId,
    repoProfileId,
    activeProfileId: snapshot.activeProfileId
  }
}

/**
 * Called by every workspace activation entry point (H53). Never blocks activation: main already
 * refuses renderer spawns under the wrong profile, so this only asks the user to switch.
 */
export function checkClientProfileForWorktree(worktreeId: string): void {
  void ensureRepoProfileResolved(getRepoIdFromWorktreeId(worktreeId))
    .then((changed) => (changed ? openMismatchDialogIfNeeded(worktreeId) : undefined))
    .catch(() => undefined)
  openMismatchDialogIfNeeded(worktreeId)
}

function openMismatchDialogIfNeeded(worktreeId: string): void {
  const { snapshot, resolvedRepoProfiles } = useClientProfileStore.getState()
  const mismatch = findClientProfileMismatch(snapshot, worktreeId, resolvedRepoProfiles)
  const state = useClientProfileMismatchStore.getState()
  if (!mismatch || state.readOnlyWorktreeIds.has(worktreeId)) {
    return
  }
  if (state.pending?.worktreeId === worktreeId) {
    return
  }
  useClientProfileMismatchStore.setState({ pending: mismatch })
}

export function markWorktreeReadOnly(worktreeId: string): void {
  useClientProfileMismatchStore.setState((state) => ({
    pending: null,
    readOnlyWorktreeIds: new Set([...state.readOnlyWorktreeIds, worktreeId])
  }))
}

export function clearPendingClientProfileMismatch(): void {
  useClientProfileMismatchStore.setState({ pending: null })
}
