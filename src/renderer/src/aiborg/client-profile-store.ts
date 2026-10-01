import { create } from 'zustand'
import type {
  ClientProfileListEntry,
  ClientProfilesState
} from '../../../shared/aiborg/client-profile-types'
import { getClientProfilesApi } from './client-profile-bridge'
import type { ClientProfileIdentity } from './client-profile-document-identity'

type ClientProfileStoreState = {
  snapshot: ClientProfilesState | null
  loadError: string | null
  /** Org matches main resolved for repos without an explicit binding. */
  resolvedRepoProfiles: Record<string, string | null>
}

export const useClientProfileStore = create<ClientProfileStoreState>(() => ({
  snapshot: null,
  loadError: null,
  resolvedRepoProfiles: {}
}))

let syncRefCount = 0
let stopSync: (() => void) | null = null

/** What main's org matches depend on; ptyBindings and secret status changes leave them valid. */
function repoMatchingKey(snapshot: ClientProfilesState | null): string {
  if (!snapshot) {
    return ''
  }
  return JSON.stringify([
    snapshot.profilesDir,
    snapshot.repoBindings,
    snapshot.profiles.map((entry) => [
      entry.id,
      entry.profile?.github.host ?? null,
      entry.profile?.github.allowedOrgs ?? null,
      entry.errors.length
    ])
  ])
}

export function applyClientProfilesState(snapshot: ClientProfilesState): void {
  // Why reset the matches only on a matching change: every terminal open/close broadcasts.
  useClientProfileStore.setState((state) => ({
    snapshot,
    loadError: null,
    resolvedRepoProfiles:
      repoMatchingKey(state.snapshot) === repoMatchingKey(snapshot)
        ? state.resolvedRepoProfiles
        : {}
  }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function refreshClientProfiles(): Promise<void> {
  const api = getClientProfilesApi()
  if (!api) {
    return
  }
  try {
    applyClientProfilesState(await api.getState())
  } catch (error) {
    useClientProfileStore.setState({ loadError: errorMessage(error) })
  }
}

/** Ref-counted so every mount point can call it; one IPC subscription serves them all. */
export function retainClientProfileSync(): () => void {
  syncRefCount += 1
  if (syncRefCount === 1) {
    const unsubscribe = getClientProfilesApi()?.onChanged(applyClientProfilesState) ?? null
    stopSync = () => unsubscribe?.()
    void refreshClientProfiles()
  }
  return () => {
    syncRefCount -= 1
    if (syncRefCount === 0) {
      stopSync?.()
      stopSync = null
    }
  }
}

export function findClientProfileEntry(
  snapshot: ClientProfilesState | null,
  profileId: string | null | undefined
): ClientProfileListEntry | null {
  if (!snapshot || !profileId) {
    return null
  }
  return snapshot.profiles.find((entry) => entry.id === profileId) ?? null
}

/** Name and colour for chrome; an invalid file still has an id but no colour. */
export function clientProfileIdentity(
  entry: ClientProfileListEntry | null
): ClientProfileIdentity | null {
  if (!entry?.profile) {
    return null
  }
  return { id: entry.id, name: entry.profile.name, color: entry.profile.color }
}

export function clientProfileDisplayName(
  snapshot: ClientProfilesState | null,
  profileId: string
): string {
  return findClientProfileEntry(snapshot, profileId)?.profile?.name ?? profileId
}

/** The profile a repo belongs to: explicit binding first, then the org match main resolved. */
export function findClientProfileIdForRepo(
  snapshot: ClientProfilesState | null,
  repoId: string,
  resolvedRepoProfiles: Record<string, string | null> = {}
): string | null {
  if (!snapshot) {
    return null
  }
  return (
    snapshot.repoBindings[repoId] ??
    resolvedRepoProfiles[repoId] ??
    snapshot.profiles.find((entry) => entry.boundRepoIds.includes(repoId))?.id ??
    null
  )
}

const repoResolutionsInFlight = new Map<string, Promise<boolean>>()

/** Resolves the org match once per repo; true when the cached answer may have changed. */
export function ensureRepoProfileResolved(repoId: string): Promise<boolean> {
  const { snapshot, resolvedRepoProfiles } = useClientProfileStore.getState()
  const resolve = getClientProfilesApi()?.resolveRepoProfile
  if (
    !snapshot?.enabled ||
    !resolve ||
    repoId in resolvedRepoProfiles ||
    snapshot.repoBindings[repoId]
  ) {
    return Promise.resolve(false)
  }
  // Why: nested activation entry points check the same repo back to back.
  const inFlight = repoResolutionsInFlight.get(repoId)
  if (inFlight) {
    return inFlight
  }
  const request = resolve({ repoId })
    .then(({ profileId }) => {
      useClientProfileStore.setState((state) => ({
        resolvedRepoProfiles: {
          ...state.resolvedRepoProfiles,
          [repoId]: profileId
        }
      }))
      return true
    })
    .finally(() => repoResolutionsInFlight.delete(repoId))
  repoResolutionsInFlight.set(repoId, request)
  return request
}

export function useActiveClientProfileIdentity(): ClientProfileIdentity | null {
  const snapshot = useClientProfileStore((s) => s.snapshot)
  return clientProfileIdentity(findClientProfileEntry(snapshot, snapshot?.activeProfileId))
}

/** Subscribed, so a profile switch re-renders the caller (H42 hides the account switchers). */
export function useClientProfileModeActive(): boolean {
  return useClientProfileStore((s) => Boolean(s.snapshot?.activeProfileId))
}

export async function switchClientProfile(profileId: string | null): Promise<void> {
  const api = getClientProfilesApi()
  if (!api) {
    return
  }
  applyClientProfilesState(await api.activate({ profileId }))
}
