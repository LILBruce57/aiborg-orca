/**
 * AI-Borg client profiles IPC: the contract the renderer codes against.
 * Channel names: CLIENT_PROFILE_IPC in src/shared/aiborg/client-profile-types.ts.
 * Preload: `window.aiborg.clientProfiles` (src/preload/api/aiborg-client-profiles-api.ts).
 *
 *   getState()                                         -> ClientProfilesState
 *   setProfilesDir({ dir: string | null })             -> ClientProfilesState
 *   activate({ profileId: string | null })             -> ClientProfilesState   (null = personal mode)
 *   saveProfile({ profile, previousId? })              -> ClientProfileSaveResult (writes <profilesDir>/<id>.json)
 *   deleteProfile({ profileId, confirmId, deleteJson }) -> ClientProfileDeleteResult
 *   setSecret({ profileId, name, value })              -> Record<name, 'set'|'missing'|'unknown'>
 *   deleteSecret({ profileId, name })                  -> same
 *   importSecretFromBitwarden({ profileId, name, item? }) -> BitwardenImportResult
 *   getBitwardenStatus()                               -> BitwardenStatus
 *   bindRepo({ repoId, profileId: string | null })     -> ClientProfilesState
 *   resolveRepoProfile({ repoId })                     -> { profileId: string | null }
 *   getLoginStatus({ profileId })                      -> ClientProfileLoginStatus
 *   writeSshPublicKey({ profileId, publicKey })        -> void
 *   readSshPublicKey({ profileId })                    -> string | null
 *   removeSshPrivateKey({ profileId })                 -> void
 *   recordMismatch({ profileId, event, worktreeId? })  -> void   (repo.mismatch.shown | .override)
 *   setMachineSettings({ sshAuthSock?, windowsSsh? })  -> ClientProfilesState
 *   getOverview({ force? })                            -> ClientProfileOverviewResult (active profile, 5-min cache)
 *   event `changed` (main -> renderer)                 -> ClientProfilesState
 *
 * Errors reject the invoke with an `AI-Borg: …` message. Secret values only ever flow
 * renderer -> main (setSecret) and never come back.
 */
import { BrowserWindow, ipcMain } from 'electron'
import { homedir } from 'node:os'
import { getAppEnvironment } from '../../../shared/app-environment'
import { CLIENT_PROFILE_IPC, type ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { CLIENT_PROFILE_ID_RE } from '../../../shared/aiborg/client-profile-schema'
import { gitExecFileAsync } from '../../git/runner'
import { appendClientProfileAudit } from '../audit/client-profile-audit'
import { readBitwardenPassword, readBitwardenStatus } from '../keychain/bitwarden-secret-import'
import { clientProfileHomeLayout } from '../profiles/client-profile-paths'
import {
  getClientProfileRuntime,
  initClientProfileRuntime,
  resetClientProfileRuntimeForTests,
  type ClientProfileRuntime,
  type InitClientProfileRuntimeOptions
} from '../profiles/client-profile-runtime'
import {
  activateClientProfile,
  deleteClientProfile,
  regenerateClientProfileHomes,
  saveClientProfile,
  setClientProfileLifecycleHooks
} from '../profiles/client-profile-lifecycle'
import {
  readClientProfileLoginStatus,
  readClientProfileSshPublicKey,
  removeClientProfileSshPrivateKey,
  writeClientProfileSshPublicKey
} from '../profiles/client-profile-home-files'
import { buildClientProfilesState, forgetClientProfileSecretStatus } from './client-profile-state'
import { resolveRepoIdClientProfileId } from '../binding/client-profile-resolution'
import { forgetCachedClientProfileSecrets } from '../binding/client-profile-core-access'
import {
  forgetClientProfileOverview,
  getClientProfileOverview
} from '../overview/client-profile-overview'

type Args = Record<string, unknown>

function args(value: unknown): Args {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
}

function str(a: Args, key: string): string {
  const value = a[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`AI-Borg: missing ${key}`)
  }
  return value.trim()
}

function nullableStr(a: Args, key: string): string | null {
  return a[key] === null || a[key] === undefined ? null : str(a, key)
}

function profileId(a: Args): string {
  const id = str(a, 'profileId')
  if (!CLIENT_PROFILE_ID_RE.test(id)) {
    throw new Error('AI-Borg: invalid profile id')
  }
  return id
}

function requireProfile(rt: ClientProfileRuntime, id: string): ClientProfile {
  const profile = rt.store.getProfile(id)
  if (!profile) {
    throw new Error(`AI-Borg: client profile "${id}" is missing or invalid`)
  }
  return profile
}

function requireSecretName(profile: ClientProfile, name: string): string {
  if (!profile.secrets || !(name in profile.secrets)) {
    throw new Error(`AI-Borg: ${name} is not a secret of profile ${profile.id}`)
  }
  return name
}

let broadcastTimer: ReturnType<typeof setTimeout> | null = null

// Why coalesced: closing a worktree tears down many terminals, one binding change each.
function scheduleBroadcast(rt: ClientProfileRuntime): void {
  if (broadcastTimer) {
    return
  }
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    broadcast(rt)
  }, 16)
}

/** After a secret, activation or delete: neither cached values nor cached status may linger. */
function forgetSecretCaches(profileId?: string): void {
  forgetCachedClientProfileSecrets()
  forgetClientProfileSecretStatus(profileId)
}

function broadcast(rt: ClientProfileRuntime): void {
  const state = buildClientProfilesState(rt)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      try {
        window.webContents.send(CLIENT_PROFILE_IPC.changed, state)
      } catch {
        // A renderer can disappear between isDestroyed() and send().
      }
    }
  }
}

function secretStatus(rt: ClientProfileRuntime, profile: ClientProfile): Record<string, string> {
  return rt.keychain.status(profile.id, Object.keys(profile.secrets ?? {}))
}

function reloadStore(rt: ClientProfileRuntime): void {
  rt.store.reload()
  rt.store.watch()
}

let registered = false
let unsubscribe: (() => void) | null = null

/** Loads the sidecar and profilesDir (AIBORG_PROFILES_DIR / userData). Idempotent. */
export function initClientProfilesForMain(
  options: Partial<InitClientProfileRuntimeOptions> = {}
): ClientProfileRuntime {
  const existing = getClientProfileRuntime()
  if (existing) {
    return existing
  }
  const rt = initClientProfileRuntime({
    userDataPath: options.userDataPath ?? getAppEnvironment().getPath('userData'),
    ...options,
    onSecretChange: (id, event, fields) => {
      forgetSecretCaches(id)
      forgetClientProfileOverview(id)
      appendClientProfileAudit(id, event, fields)
      options.onSecretChange?.(id, event, fields)
    }
  })
  setClientProfileLifecycleHooks({
    readGitVersion: async () => (await gitExecFileAsync(['--version'], { cwd: homedir() })).stdout
  })
  rt.store.watch()
  void regenerateClientProfileHomes(rt)
  const offStore = rt.store.onChange(() => {
    void regenerateClientProfileHomes(rt)
    forgetClientProfileSecretStatus()
    broadcast(rt)
  })
  const offSidecar = rt.sidecar.onChange(() => scheduleBroadcast(rt))
  unsubscribe = () => {
    offStore()
    offSidecar()
  }
  return rt
}

export function resetClientProfilesForTests(): void {
  unsubscribe?.()
  unsubscribe = null
  if (broadcastTimer) {
    clearTimeout(broadcastTimer)
    broadcastTimer = null
  }
  forgetSecretCaches()
  resetClientProfileRuntimeForTests()
}

export { activateClientProfile }

export function bindRepoToClientProfile(repoId: string, profileId: string | null): void {
  const rt = initClientProfilesForMain()
  if (profileId !== null && !rt.store.getProfile(profileId)) {
    throw new Error(`AI-Borg: client profile "${profileId}" is missing or invalid`)
  }
  rt.sidecar.setRepoBinding(repoId, profileId)
}

/** H37: called once next to registerOrcaProfileHandlers. */
export function registerAiborgClientProfileHandlers(): void {
  if (registered) {
    return
  }
  registered = true
  initClientProfilesForMain()
  // Why a getter: tests reset and re-init the runtime under the registered handlers.
  const handle = <T>(
    channel: string,
    run: (a: Args, rt: ClientProfileRuntime) => T | Promise<T>
  ): void => {
    ipcMain.handle(channel, (_event, raw: unknown) => run(args(raw), initClientProfilesForMain()))
  }
  const state = (_a: Args, rt: ClientProfileRuntime): ReturnType<typeof buildClientProfilesState> =>
    buildClientProfilesState(rt)

  handle(CLIENT_PROFILE_IPC.getState, state)
  handle(CLIENT_PROFILE_IPC.setProfilesDir, (a, rt) => {
    rt.sidecar.setProfilesDir(nullableStr(a, 'dir'))
    reloadStore(rt)
    forgetSecretCaches()
    broadcast(rt)
    return state(a, rt)
  })
  handle(CLIENT_PROFILE_IPC.activate, async (a, rt) => {
    const id = a.profileId === null ? null : profileId(a)
    forgetSecretCaches()
    await activateClientProfile(id, rt)
    return state(a, rt)
  })
  handle(CLIENT_PROFILE_IPC.saveProfile, async (a, rt) => {
    const result = await saveClientProfile(a.profile, nullableStr(a, 'previousId'), rt)
    return result.ok ? { ok: true, state: state(a, rt) } : result
  })
  handle(CLIENT_PROFILE_IPC.deleteProfile, async (a, rt) => {
    const id = profileId(a)
    const result = await deleteClientProfile(
      { profileId: id, confirmId: str(a, 'confirmId'), deleteJson: a.deleteJson === true },
      rt
    )
    forgetSecretCaches(id)
    forgetClientProfileOverview(id)
    return result.ok ? { ok: true, state: state(a, rt) } : result
  })
  handle(CLIENT_PROFILE_IPC.setSecret, async (a, rt) => {
    await rt.keychainReady
    const profile = requireProfile(rt, profileId(a))
    const name = requireSecretName(profile, str(a, 'name'))
    if (typeof a.value !== 'string') {
      throw new Error('AI-Borg: missing value')
    }
    rt.keychain.setSecret(profile.id, name, a.value.trim())
    return secretStatus(rt, profile)
  })
  handle(CLIENT_PROFILE_IPC.deleteSecret, async (a, rt) => {
    await rt.keychainReady
    const profile = requireProfile(rt, profileId(a))
    const name = requireSecretName(profile, str(a, 'name'))
    rt.keychain.deleteSecret(profile.id, name)
    return secretStatus(rt, profile)
  })
  handle(CLIENT_PROFILE_IPC.importSecretFromBitwarden, async (a, rt) => {
    const profile = requireProfile(rt, profileId(a))
    const name = requireSecretName(profile, str(a, 'name'))
    const item = nullableStr(a, 'item') ?? profile.secrets?.[name]?.bitwarden ?? null
    if (!item) {
      return {
        ok: false,
        reason: 'no-item-ref',
        message: 'No Bitwarden item is configured for this secret.'
      }
    }
    const read = await readBitwardenPassword(item, rt.env)
    await rt.keychainReady
    if (!read.ok) {
      return read
    }
    rt.keychain.setSecret(profile.id, name, read.value, 'bitwarden')
    return { ok: true }
  })
  handle(CLIENT_PROFILE_IPC.getBitwardenStatus, (_a, rt) => readBitwardenStatus(rt.env))
  handle(CLIENT_PROFILE_IPC.bindRepo, (a, rt) => {
    const target = a.profileId === null ? null : requireProfile(rt, profileId(a)).id
    rt.sidecar.setRepoBinding(str(a, 'repoId'), target)
    return state(a, rt)
  })
  handle(CLIENT_PROFILE_IPC.resolveRepoProfile, (a) => ({
    profileId: resolveRepoIdClientProfileId(str(a, 'repoId'))
  }))
  handle(CLIENT_PROFILE_IPC.getLoginStatus, (a, rt) =>
    readClientProfileLoginStatus(clientProfileHomeLayout(rt.root, profileId(a)))
  )
  handle(CLIENT_PROFILE_IPC.writeSshPublicKey, async (a, rt) => {
    const profile = requireProfile(rt, profileId(a))
    await writeClientProfileSshPublicKey(
      profile,
      clientProfileHomeLayout(rt.root, profile.id),
      str(a, 'publicKey')
    )
  })
  handle(CLIENT_PROFILE_IPC.readSshPublicKey, (a, rt) => {
    const profile = requireProfile(rt, profileId(a))
    return readClientProfileSshPublicKey(profile, clientProfileHomeLayout(rt.root, profile.id))
  })
  handle(CLIENT_PROFILE_IPC.removeSshPrivateKey, async (a, rt) => {
    const profile = requireProfile(rt, profileId(a))
    await removeClientProfileSshPrivateKey(profile, clientProfileHomeLayout(rt.root, profile.id))
  })
  handle(CLIENT_PROFILE_IPC.recordMismatch, (a) => {
    const event =
      a.event === 'repo.mismatch.override' ? 'repo.mismatch.override' : 'repo.mismatch.shown'
    const worktreeId = typeof a.worktreeId === 'string' ? a.worktreeId : null
    appendClientProfileAudit(profileId(a), event, { worktreeId })
  })
  handle(CLIENT_PROFILE_IPC.setMachineSettings, (a, rt) => {
    rt.sidecar.setMachine({
      ...('sshAuthSock' in a ? { sshAuthSock: nullableStr(a, 'sshAuthSock') } : {}),
      ...('windowsSsh' in a ? { windowsSsh: nullableStr(a, 'windowsSsh') } : {})
    })
    return state(a, rt)
  })
  handle(CLIENT_PROFILE_IPC.getOverview, (a) =>
    getClientProfileOverview({ force: a.force === true })
  )
}
