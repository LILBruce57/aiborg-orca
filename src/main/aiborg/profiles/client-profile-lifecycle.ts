import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ClientProfile,
  ClientProfileDeleteResult
} from '../../../shared/aiborg/client-profile-types'
import {
  findDuplicateAllowedOrgs,
  validateClientProfile
} from '../../../shared/aiborg/client-profile-schema'
import {
  appendClientProfileAudit,
  formatClientProfileAuditLine
} from '../audit/client-profile-audit'
import {
  ensureClientProfileHome,
  isGitVersionSupportedForClientProfiles,
  removeClientProfileHome
} from './client-profile-dirs'
import {
  clientProfileHomeLayout,
  resolveClientProfileAuditArchiveDir,
  type ClientProfileHomeLayout
} from './client-profile-paths'
import { getClientProfileRuntime, type ClientProfileRuntime } from './client-profile-runtime'

export type ClientProfileLifecycleHooks = {
  /** Agent hook install (H35) and optional MCP sync, run in profile env. */
  onActivated?: (profile: ClientProfile, layout: ClientProfileHomeLayout) => Promise<void> | void
  onCreated?: (profile: ClientProfile, layout: ClientProfileHomeLayout) => Promise<void> | void
  /** E.g. the macOS Claude keychain item derived from P/claude. */
  onDeleted?: (profileId: string, layout: ClientProfileHomeLayout) => Promise<void> | void
  /** Running terminals or structured sessions bound to the profile. */
  isProfileInUse?: (profileId: string) => boolean
  readGitVersion?: () => Promise<string>
}

let lifecycleHooks: ClientProfileLifecycleHooks = {}

export function setClientProfileLifecycleHooks(hooks: ClientProfileLifecycleHooks): void {
  lifecycleHooks = { ...lifecycleHooks, ...hooks }
}

async function assertActivatable(rt: ClientProfileRuntime, profile: ClientProfile): Promise<void> {
  await rt.keychainReady
  if (!rt.keychain.isAvailable()) {
    appendClientProfileAudit(profile.id, 'keychain.error', { phase: 'activate' })
    throw new Error('AI-Borg: the OS keychain is unavailable, so this profile cannot be activated.')
  }
  if (lifecycleHooks.readGitVersion) {
    const output = await lifecycleHooks.readGitVersion().catch(() => '')
    if (!isGitVersionSupportedForClientProfiles(output)) {
      throw new Error('AI-Borg: client profiles need git 2.32 or newer.')
    }
  }
}

function requireRuntime(): ClientProfileRuntime {
  const rt = getClientProfileRuntime()
  if (!rt) {
    throw new Error('AI-Borg: client profiles are not initialised in this process.')
  }
  return rt
}

function home(rt: ClientProfileRuntime, profile: ClientProfile): Promise<ClientProfileHomeLayout> {
  return ensureClientProfileHome(profile, {
    root: rt.root,
    machine: rt.sidecar.read().machine,
    env: rt.env,
    home: rt.home
  })
}

/**
 * Rewrites P/* for every valid profile, on startup and whenever a profile JSON changes (§3.3),
 * so a profile used only by headless spawns still has its hooks and credential reset.
 */
export async function regenerateClientProfileHomes(
  rt: ClientProfileRuntime = requireRuntime()
): Promise<void> {
  // Why swallow: a failed rewrite leaves the files missing, and spawns then refuse (fail closed).
  await Promise.all(rt.store.validProfiles().map((profile) => home(rt, profile).catch(() => null)))
}

/** null switches to personal mode. Never touches running terminals (§4.1). */
export async function activateClientProfile(
  profileId: string | null,
  rt: ClientProfileRuntime = requireRuntime()
): Promise<void> {
  const previous = rt.sidecar.read().activeProfileId
  if (profileId === null) {
    rt.sidecar.setActiveProfileId(null)
    if (previous) {
      appendClientProfileAudit(previous, 'profile.deactivate')
    }
    return
  }
  const profile = rt.store.getProfile(profileId)
  if (!profile) {
    throw new Error(`AI-Borg: client profile "${profileId}" is missing or invalid.`)
  }
  await assertActivatable(rt, profile)
  const layout = await home(rt, profile)
  await lifecycleHooks.onActivated?.(profile, layout)
  rt.sidecar.setActiveProfileId(profile.id)
  if (previous && previous !== profile.id) {
    appendClientProfileAudit(previous, 'profile.deactivate')
  }
  appendClientProfileAudit(profile.id, 'profile.activate')
}

/** Create or update `<profilesDir>/<id>.json`, then regenerate P/*. The id cannot change. */
export async function saveClientProfile(
  raw: unknown,
  previousId?: string | null,
  rt: ClientProfileRuntime = requireRuntime()
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const id =
    raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string' ? raw.id : undefined
  const result = validateClientProfile(raw, id)
  if (!result.ok) {
    return result
  }
  const profile = result.profile
  if (previousId && previousId !== profile.id) {
    return { ok: false, errors: ['the profile id cannot change; create a new profile instead'] }
  }
  const exists = rt.store.snapshot().entries.some((entry) => entry.id === profile.id)
  if (!previousId && exists) {
    return { ok: false, errors: [`a profile with id "${profile.id}" already exists`] }
  }
  const others = rt.store.validProfiles().filter((item) => item.id !== profile.id)
  const duplicates = findDuplicateAllowedOrgs([...others, profile])
  if (duplicates.size > 0) {
    return {
      ok: false,
      errors: [...duplicates.keys()].map((org) => `org ${org} is already listed in another profile`)
    }
  }
  try {
    rt.store.writeProfile(profile)
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  }
  const layout = await home(rt, profile)
  if (!exists) {
    await lifecycleHooks.onCreated?.(profile, layout)
  }
  appendClientProfileAudit(profile.id, exists ? 'profile.update' : 'profile.create')
  return { ok: true }
}

function archiveAudit(rt: ClientProfileRuntime, profileId: string): string {
  const archiveDir = resolveClientProfileAuditArchiveDir(rt.root)
  mkdirSync(archiveDir, { recursive: true })
  const target = join(
    archiveDir,
    `${profileId}-${new Date().toISOString().slice(0, 10)}-${Date.now()}.jsonl`
  )
  const source = clientProfileHomeLayout(rt.root, profileId).audit
  if (existsSync(source)) {
    copyFileSync(source, target)
  }
  return target
}

/** Delete flow (§6): archive audit, wipe P, keychain entries and bindings; JSON optional. */
export async function deleteClientProfile(
  input: { profileId: string; confirmId: string; deleteJson: boolean },
  rt: ClientProfileRuntime = requireRuntime()
): Promise<ClientProfileDeleteResult | { ok: true }> {
  const { profileId } = input
  if (input.confirmId !== profileId) {
    return { ok: false, reason: 'confirm-mismatch', message: 'Type the profile id to confirm.' }
  }
  if (!rt.store.snapshot().entries.some((entry) => entry.id === profileId)) {
    return { ok: false, reason: 'not-found', message: `No profile "${profileId}".` }
  }
  if (lifecycleHooks.isProfileInUse?.(profileId)) {
    return {
      ok: false,
      reason: 'in-use',
      message: 'Close the terminals and sessions of this profile first.'
    }
  }
  try {
    await rt.keychainReady
    const archive = archiveAudit(rt, profileId)
    const layout = clientProfileHomeLayout(rt.root, profileId)
    await removeClientProfileHome(rt.root, profileId)
    // Why before the sidecar: the stored names are the only way to retry a failed keychain wipe.
    rt.keychain.deleteAll(profileId)
    await lifecycleHooks.onDeleted?.(profileId, layout)
    rt.sidecar.removeProfile(profileId)
    if (input.deleteJson) {
      rt.store.deleteProfileFile(profileId)
    }
    appendFileSync(
      archive,
      formatClientProfileAuditLine('profile.delete', profileId, { deleteJson: input.deleteJson })
    )
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
