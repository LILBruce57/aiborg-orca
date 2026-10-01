import { homedir } from 'node:os'
import {
  ClientProfileKeychain,
  installClientProfileKeychain,
  loadNapiKeyringBackend,
  preloadNapiKeyring,
  resolveClientProfileKeychainService,
  type ClientProfileKeychainHooks,
  type KeyringBackend
} from '../keychain/client-profile-keychain'
import { resolveClientProfilesRoot } from './client-profile-paths'
import { ClientProfileSidecarStore, clientProfileSidecarPath } from './client-profile-sidecar'
import { ClientProfileStore } from './client-profile-store'

export type ClientProfileRuntime = {
  mode: 'app' | 'orcad'
  sidecar: ClientProfileSidecarStore
  store: ClientProfileStore
  keychain: ClientProfileKeychain
  /** Settles once the keychain library has loaded (or failed to); activation awaits it. */
  keychainReady: Promise<void>
  /** P root (`~/.aiborg/profiles` or AIBORG_PROFILES_ROOT). */
  root: string
  /** The user's own env; profile env never enters it (invariant 1). */
  env: NodeJS.ProcessEnv
  /** The user's home, read for the global gitconfig's safe.directory entries. */
  home: string
}

export type InitClientProfileRuntimeOptions = {
  userDataPath: string
  mode?: 'app' | 'orcad'
  env?: NodeJS.ProcessEnv
  home?: string
  loadKeyringBackend?: () => KeyringBackend
  onSecretChange?: ClientProfileKeychainHooks['onSecretChange']
}

let runtime: ClientProfileRuntime | null = null

function orcadKeyringBackend(): KeyringBackend {
  // Why: orcad has no keychain (orcad-entry.ts SecretStore); profile-bound spawns there fail closed.
  throw new Error('the headless orcad runtime has no keychain access')
}

export function initClientProfileRuntime(
  options: InitClientProfileRuntimeOptions
): ClientProfileRuntime {
  const env = options.env ?? process.env
  const mode = options.mode ?? 'app'
  const sidecar = new ClientProfileSidecarStore(clientProfileSidecarPath(options.userDataPath))
  const store = new ClientProfileStore(() => sidecar.read().profilesDir, env)
  store.reload()
  const usesNativeKeyring = mode !== 'orcad' && !options.loadKeyringBackend
  const loader =
    mode === 'orcad' ? orcadKeyringBackend : (options.loadKeyringBackend ?? loadNapiKeyringBackend)
  const keychainReady = usesNativeKeyring ? preloadNapiKeyring() : Promise.resolve()
  const keychain = new ClientProfileKeychain(sidecar, loader, {
    service: resolveClientProfileKeychainService(env),
    profileSecretNames: (profileId) => Object.keys(store.getProfile(profileId)?.secrets ?? {}),
    onSecretChange: options.onSecretChange
  })
  installClientProfileKeychain(keychain)
  const home = options.home ?? homedir()
  const created: ClientProfileRuntime = {
    mode,
    sidecar,
    store,
    keychain,
    keychainReady,
    root: resolveClientProfilesRoot(env, home),
    env,
    home
  }
  runtime = created
  return created
}

export function getClientProfileRuntime(): ClientProfileRuntime | null {
  return runtime
}

export function resetClientProfileRuntimeForTests(): void {
  runtime?.store.stopWatching()
  runtime?.sidecar.flush()
  runtime = null
  installClientProfileKeychain(null)
}
