import type {
  ClientProfile,
  ClientProfileAuditEvent,
  ClientProfileSpawnTarget
} from '../../../shared/aiborg/client-profile-types'
import {
  appendClientProfileAudit,
  type ClientProfileAuditFieldValue
} from '../audit/client-profile-audit'
import {
  clientProfileEnvDepsFromRuntime,
  planClientProfileEnv
} from '../env/apply-client-profile-env'
import type { ClientProfileEnvPlan } from '../env/client-profile-env'
import {
  clientProfileHomeLayout,
  resolveClientProfilesRoot,
  type ClientProfileHomeLayout
} from '../profiles/client-profile-paths'
import { getClientProfileRuntime } from '../profiles/client-profile-runtime'

// The binding layer's only door into the profiles runtime (sidecar, store, keychain, audit).

/** Profiles are on only while a profiles folder is configured; bindings alone change nothing. */
export function hasClientProfilesConfigured(): boolean {
  return Boolean(getClientProfileRuntime()?.store.snapshot().dir)
}

/** Every profile file naming `owner`, valid or not; an invalid match must refuse, not fall open. */
export function listClientProfilesClaimingOwner(host: string, owner: string): string[] {
  return getClientProfileRuntime()?.store.claimingProfileIds(host, owner) ?? []
}

export function getClientProfileById(profileId: string): ClientProfile | null {
  return getClientProfileRuntime()?.store.getProfile(profileId) ?? null
}

export function getActiveClientProfileId(): string | null {
  return getClientProfileRuntime()?.sidecar.read().activeProfileId ?? null
}

export function getActiveClientProfile(): ClientProfile | null {
  const activeId = getActiveClientProfileId()
  return activeId ? getClientProfileById(activeId) : null
}

export function getClientProfileRepoBindings(): Readonly<Record<string, string>> {
  return getClientProfileRuntime()?.sidecar.read().repoBindings ?? {}
}

export function getClientProfilePtyBinding(ptyId: string): string | null {
  return getClientProfileRuntime()?.sidecar.read().ptyBindings[ptyId] ?? null
}

export function setClientProfilePtyBinding(ptyId: string, profileId: string | null): void {
  getClientProfileRuntime()?.sidecar.setPtyBinding(ptyId, profileId)
}

export function getClientProfilesRoot(): string {
  return getClientProfileRuntime()?.root ?? resolveClientProfilesRoot()
}

export function getClientProfileLayout(profileId: string): ClientProfileHomeLayout {
  return clientProfileHomeLayout(getClientProfilesRoot(), profileId)
}

export function auditClientProfile(
  profileId: string,
  event: ClientProfileAuditEvent,
  fields: Record<string, ClientProfileAuditFieldValue | undefined> = {}
): void {
  if (profileId) {
    appendClientProfileAudit(profileId, event, fields, getClientProfilesRoot())
  }
}

/** Keychain-backed env plan for one child; throws ClientProfileRefusalError when it can't apply. */
export function planClientProfileProcessEnv(
  profile: ClientProfile,
  target: ClientProfileSpawnTarget,
  baseEnv: NodeJS.ProcessEnv
): ClientProfileEnvPlan {
  const rt = getClientProfileRuntime()
  const deps = rt ? clientProfileEnvDepsFromRuntime(rt) : undefined
  return planClientProfileEnv(
    profile,
    target,
    baseEnv,
    deps && {
      ...deps,
      readSecret: (profileId, name) => readSecretCached(profileId, name, deps.readSecret)
    }
  )
}

// Why: Orca's own git polls status per worktree; a keychain round trip per call adds up. Memory only.
const SECRET_CACHE_MS = 15_000
const secretCache = new Map<string, { value: string; readAt: number }>()

function readSecretCached(
  profileId: string,
  name: string,
  read: (profileId: string, name: string) => string | null
): string | null {
  const key = `${profileId}/${name}`
  const cached = secretCache.get(key)
  if (cached && Date.now() - cached.readAt < SECRET_CACHE_MS) {
    return cached.value
  }
  const value = read(profileId, name)
  // Why not cache a miss: the wizard stores a secret and checks the account right after.
  if (value !== null) {
    secretCache.set(key, { value, readAt: Date.now() })
  } else {
    secretCache.delete(key)
  }
  return value
}

/** Drops cached keychain reads after a secret was set or deleted, a profile was deleted or activated. */
export function forgetCachedClientProfileSecrets(): void {
  secretCache.clear()
}
