import type {
  ClientProfileSecretState,
  ClientProfilesState
} from '../../../shared/aiborg/client-profile-types'
import type { ClientProfileRuntime } from '../profiles/client-profile-runtime'

type SecretStatusCache = {
  keychainAvailable: boolean | null
  byProfile: Map<string, Record<string, ClientProfileSecretState>>
}

// Why cached: the state is rebuilt on every terminal open and close (ptyBindings), and each
// keychain read can raise a macOS access prompt. Refreshed only when secrets can have changed.
const secretStatusCache: SecretStatusCache = { keychainAvailable: null, byProfile: new Map() }

/** Drops cached secret status: one profile after a secret change, all after activation or reload. */
export function forgetClientProfileSecretStatus(profileId?: string): void {
  if (profileId === undefined) {
    secretStatusCache.keychainAvailable = null
    secretStatusCache.byProfile.clear()
  } else {
    secretStatusCache.byProfile.delete(profileId)
  }
}

function cachedKeychainAvailable(rt: ClientProfileRuntime): boolean {
  secretStatusCache.keychainAvailable ??= rt.keychain.isAvailable()
  return secretStatusCache.keychainAvailable
}

function cachedSecretStatus(
  rt: ClientProfileRuntime,
  profileId: string,
  names: readonly string[]
): Record<string, ClientProfileSecretState> {
  const cached = secretStatusCache.byProfile.get(profileId)
  if (cached && names.every((name) => name in cached)) {
    return Object.fromEntries(names.map((name) => [name, cached[name]]))
  }
  const fresh = rt.keychain.status(profileId, names)
  secretStatusCache.byProfile.set(profileId, fresh)
  return fresh
}

/** Renderer view of profiles and bindings. Secret status only (set / missing), never values. */
export function buildClientProfilesState(rt: ClientProfileRuntime): ClientProfilesState {
  const sidecar = rt.sidecar.read()
  const snapshot = rt.store.snapshot()
  const keychainAvailable = cachedKeychainAvailable(rt)
  return {
    enabled: snapshot.dir !== null,
    profilesDir: snapshot.dir,
    profilesDirSource: snapshot.source,
    profilesDirWritable: snapshot.writable,
    profilesDirError: snapshot.error,
    profilesRoot: rt.root,
    activeProfileId: sidecar.activeProfileId,
    keychainAvailable,
    repoBindings: { ...sidecar.repoBindings },
    ptyBindings: { ...sidecar.ptyBindings },
    profiles: snapshot.entries.map((entry) => {
      const names = Object.keys(entry.profile?.secrets ?? {})
      return {
        id: entry.id,
        fileName: entry.fileName,
        profile: entry.profile,
        errors: [...entry.errors],
        secretStatus: keychainAvailable
          ? cachedSecretStatus(rt, entry.id, names)
          : Object.fromEntries(names.map((name) => [name, 'unknown' as const])),
        boundRepoIds: Object.entries(sidecar.repoBindings)
          .filter(([, id]) => id === entry.id)
          .map(([repoId]) => repoId)
      }
    })
  }
}
