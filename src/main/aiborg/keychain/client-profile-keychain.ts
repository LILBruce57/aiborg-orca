import { CLIENT_PROFILE_ID_RE } from '../../../shared/aiborg/client-profile-schema'
import type { ClientProfileSecretState } from '../../../shared/aiborg/client-profile-types'

/** Fixed before the first secret is stored (design §9); changing it orphans stored entries. */
export const CLIENT_PROFILE_KEYCHAIN_SERVICE = 'be.aiborg.desktop.client-profiles'
/** Smoke runs only: a `<service>.test…` namespace, so fake secrets never mix with real ones. */
export const AIBORG_KEYCHAIN_SERVICE_ENV = 'AIBORG_KEYCHAIN_SERVICE'

export function resolveClientProfileKeychainService(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[AIBORG_KEYCHAIN_SERVICE_ENV]?.trim()
  // Why the prefix rule: the override can never point at another app's keychain entries.
  return override?.startsWith(`${CLIENT_PROFILE_KEYCHAIN_SERVICE}.test`)
    ? override
    : CLIENT_PROFILE_KEYCHAIN_SERVICE
}

const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/
const MAX_SECRET_LENGTH = 1024

export type KeyringEntryLike = {
  getPassword(): string | null | undefined
  setPassword(value: string): void
  deletePassword(): boolean | void
}

export type KeyringBackend = {
  createEntry(service: string, account: string): KeyringEntryLike
}

/** Keychain APIs cannot enumerate entries, so the names live in the sidecar. */
export type ClientProfileSecretNameRegistry = {
  listSecretNames(profileId: string): string[]
  recordSecretName(profileId: string, name: string): void
  forgetSecretName(profileId: string, name: string): void
}

export class ClientProfileKeychainUnavailableError extends Error {
  constructor(detail: string) {
    super(`AI-Borg: the OS keychain is unavailable, so client profiles cannot be used (${detail}).`)
    this.name = 'ClientProfileKeychainUnavailableError'
  }
}

type KeyringModule = { Entry: new (service: string, account: string) => KeyringEntryLike }

function isKeyringModule(value: unknown): value is KeyringModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Entry' in value &&
    typeof value.Entry === 'function'
  )
}

let napiKeyring: KeyringModule | null = null
let napiKeyringError: string | null = null
let napiKeyringLoad: Promise<void> | null = null

/**
 * Loads @napi-rs/keyring once: Windows Credential Manager / macOS Keychain, no argv, no shell.
 * Why a dynamic import: a missing native binary then refuses activation instead of crashing main,
 * and tests can replace the module (vi.mock never sees a createRequire call).
 */
export function preloadNapiKeyring(): Promise<void> {
  napiKeyringLoad ??= import('@napi-rs/keyring').then(
    (loaded: unknown) => {
      const candidate =
        typeof loaded === 'object' && loaded !== null && 'default' in loaded && !('Entry' in loaded)
          ? loaded.default
          : loaded
      if (isKeyringModule(candidate)) {
        napiKeyring = candidate
      } else {
        napiKeyringError = '@napi-rs/keyring has no Entry export'
      }
    },
    (error: unknown) => {
      napiKeyringError = error instanceof Error ? error.message : String(error)
    }
  )
  return napiKeyringLoad
}

export function loadNapiKeyringBackend(): KeyringBackend {
  const loaded = napiKeyring
  if (!loaded) {
    throw new Error(napiKeyringError ?? 'the keychain library has not finished loading')
  }
  return { createEntry: (service, account) => new loaded.Entry(service, account) }
}

export function clientProfileKeychainAccount(profileId: string, name: string): string {
  if (!CLIENT_PROFILE_ID_RE.test(profileId) || !SECRET_NAME_RE.test(name)) {
    throw new Error('AI-Borg: invalid client profile id or secret name')
  }
  return `client-profile/${profileId}/${name}`
}

/** Secrets only ever live here. No plaintext or safeStorage fallback: unavailable means refuse. */
export type ClientProfileKeychainHooks = {
  /** Defaults to CLIENT_PROFILE_KEYCHAIN_SERVICE. */
  service?: string
  /** The profile JSON's secret refs: status reports them even when never stored. */
  profileSecretNames?: (profileId: string) => readonly string[]
  /** `secret.set` / `secret.delete` audit; names only. */
  onSecretChange?: (
    profileId: string,
    event: 'secret.set' | 'secret.delete',
    fields: { name: string; source?: string }
  ) => void
}

export class ClientProfileKeychain {
  private backend: KeyringBackend | null = null

  constructor(
    private readonly registry: ClientProfileSecretNameRegistry,
    private readonly loadBackend: () => KeyringBackend = loadNapiKeyringBackend,
    private readonly hooks: ClientProfileKeychainHooks = {}
  ) {}

  // Why no cached failure: a load that was still pending must not disable the keychain for good.
  private requireBackend(): KeyringBackend {
    if (this.backend) {
      return this.backend
    }
    try {
      this.backend = this.loadBackend()
      return this.backend
    } catch (error) {
      throw new ClientProfileKeychainUnavailableError(
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private entry(profileId: string, name: string): KeyringEntryLike {
    return this.requireBackend().createEntry(
      this.hooks.service ?? CLIENT_PROFILE_KEYCHAIN_SERVICE,
      clientProfileKeychainAccount(profileId, name)
    )
  }

  isAvailable(): boolean {
    try {
      // Why a read: Linux Secret Service can load yet fail on first use.
      this.requireBackend()
        .createEntry(this.hooks.service ?? CLIENT_PROFILE_KEYCHAIN_SERVICE, 'client-profile/probe')
        .getPassword()
      return true
    } catch {
      return false
    }
  }

  getSecret(profileId: string, name: string): string | null {
    try {
      return this.entry(profileId, name).getPassword() ?? null
    } catch (error) {
      if (error instanceof ClientProfileKeychainUnavailableError) {
        throw error
      }
      // keyring reports a missing entry as an error on some platforms.
      if (/no (matching )?entry|not found|NoEntry/i.test(String(error))) {
        return null
      }
      throw new ClientProfileKeychainUnavailableError(
        error instanceof Error ? error.message : 'read failed'
      )
    }
  }

  setSecret(profileId: string, name: string, value: string, source?: string): void {
    if (value.length === 0 || value.length > MAX_SECRET_LENGTH || /[\r\n]/.test(value)) {
      throw new Error('AI-Borg: a secret must be one non-empty line of at most 1024 characters')
    }
    this.entry(profileId, name).setPassword(value)
    this.registry.recordSecretName(profileId, name)
    this.hooks.onSecretChange?.(profileId, 'secret.set', source ? { name, source } : { name })
  }

  deleteSecret(profileId: string, name: string): void {
    this.removeEntry(profileId, name)
    this.hooks.onSecretChange?.(profileId, 'secret.delete', { name })
  }

  private removeEntry(profileId: string, name: string): void {
    try {
      this.entry(profileId, name).deletePassword()
    } catch (error) {
      if (error instanceof ClientProfileKeychainUnavailableError) {
        throw error
      }
      // Already absent.
    }
    this.registry.forgetSecretName(profileId, name)
  }

  /**
   * Profile delete: no per-secret audit, since P (and its audit log) is being wiped. The profile
   * JSON's names join the recorded ones, so a reset or rewritten sidecar orphans nothing.
   */
  deleteAll(profileId: string): void {
    const names = new Set([
      ...this.registry.listSecretNames(profileId),
      ...(this.hooks.profileSecretNames?.(profileId) ?? [])
    ])
    for (const name of names) {
      this.removeEntry(profileId, name)
    }
  }

  /** set / missing per name; never the value. `unknown` when the keychain cannot be read. */
  status(
    profileId: string,
    names: readonly string[] = [
      ...new Set([
        ...(this.hooks.profileSecretNames?.(profileId) ?? []),
        ...this.registry.listSecretNames(profileId)
      ])
    ]
  ): Record<string, ClientProfileSecretState> {
    const result: Record<string, ClientProfileSecretState> = {}
    for (const name of names) {
      try {
        result[name] = this.getSecret(profileId, name) === null ? 'missing' : 'set'
      } catch {
        result[name] = 'unknown'
      }
    }
    return result
  }
}

let installed: ClientProfileKeychain | null = null

/** Called by the runtime; the module-level API below (design §2) uses this instance. */
export function installClientProfileKeychain(keychain: ClientProfileKeychain | null): void {
  installed = keychain
}

function requireInstalled(): ClientProfileKeychain {
  if (!installed) {
    throw new ClientProfileKeychainUnavailableError('client profiles are not initialised')
  }
  return installed
}

export function getSecret(profileId: string, name: string): string | null {
  return requireInstalled().getSecret(profileId, name)
}

export function setSecret(profileId: string, name: string, value: string): void {
  requireInstalled().setSecret(profileId, name, value)
}

export function deleteSecret(profileId: string, name: string): void {
  requireInstalled().deleteSecret(profileId, name)
}

export function deleteAll(profileId: string): void {
  requireInstalled().deleteAll(profileId)
}

/** Per recorded name (or `names`): set / missing / unknown. Never the value. */
export function status(
  profileId: string,
  names?: readonly string[]
): Record<string, ClientProfileSecretState> {
  return requireInstalled().status(profileId, names)
}
