// In-memory stand-in for `@napi-rs/keyring`. Use from a test file as:
//   vi.mock('@napi-rs/keyring', async () => (await import('./client-profile-keyring-test-fixture')).keyringModule)

/** Decided service name (design §9 open point, fixed for v1). */
export const CLIENT_PROFILE_KEYCHAIN_SERVICE = 'be.aiborg.desktop.client-profiles'

export function keychainAccount(profileId: string, name: string): string {
  return `client-profile/${profileId}/${name}`
}

type KeyringCall = {
  op: 'get' | 'set' | 'delete'
  service: string
  account: string
}

const calls: KeyringCall[] = []

export const keyringState = {
  entries: new Map<string, string>(),
  calls,
  /** When true every call throws, like a locked or missing OS keychain. */
  unavailable: false
}

export function resetKeyring(): void {
  keyringState.entries.clear()
  keyringState.calls.length = 0
  keyringState.unavailable = false
}

export function seedKeyringSecret(profileId: string, name: string, value: string): void {
  keyringState.entries.set(
    entryKey(CLIENT_PROFILE_KEYCHAIN_SERVICE, keychainAccount(profileId, name)),
    value
  )
}

export function keyringValue(profileId: string, name: string): string | undefined {
  return keyringState.entries.get(
    entryKey(CLIENT_PROFILE_KEYCHAIN_SERVICE, keychainAccount(profileId, name))
  )
}

export function accountsForProfile(profileId: string): string[] {
  const prefix = `${CLIENT_PROFILE_KEYCHAIN_SERVICE}\u0000client-profile/${profileId}/`
  return [...keyringState.entries.keys()].filter((key) => key.startsWith(prefix))
}

function entryKey(service: string, account: string): string {
  return `${service}\u0000${account}`
}

function assertAvailable(): void {
  if (keyringState.unavailable) {
    throw new Error('Platform secure storage failure: keychain unavailable (test)')
  }
}

class Entry {
  constructor(
    private readonly service: string,
    private readonly account: string
  ) {}

  getPassword(): string | null {
    keyringState.calls.push({
      op: 'get',
      service: this.service,
      account: this.account
    })
    assertAvailable()
    return keyringState.entries.get(entryKey(this.service, this.account)) ?? null
  }

  setPassword(password: string): void {
    keyringState.calls.push({
      op: 'set',
      service: this.service,
      account: this.account
    })
    assertAvailable()
    keyringState.entries.set(entryKey(this.service, this.account), password)
  }

  deletePassword(): boolean {
    keyringState.calls.push({
      op: 'delete',
      service: this.service,
      account: this.account
    })
    assertAvailable()
    return keyringState.entries.delete(entryKey(this.service, this.account))
  }

  deleteCredential(): boolean {
    return this.deletePassword()
  }
}

export const keyringModule = { Entry }
