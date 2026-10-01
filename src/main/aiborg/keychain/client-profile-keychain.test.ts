import { describe, expect, it } from 'vitest'
import {
  CLIENT_PROFILE_KEYCHAIN_SERVICE,
  ClientProfileKeychain,
  ClientProfileKeychainUnavailableError,
  clientProfileKeychainAccount,
  deleteAll,
  getSecret,
  installClientProfileKeychain,
  resolveClientProfileKeychainService,
  setSecret,
  status,
  type ClientProfileSecretNameRegistry,
  type KeyringBackend
} from './client-profile-keychain'

function memoryKeyring(): { backend: KeyringBackend; store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    backend: {
      createEntry: (service, account) => {
        const key = `${service}|${account}`
        return {
          getPassword: () => store.get(key) ?? null,
          setPassword: (value) => {
            store.set(key, value)
          },
          deletePassword: () => store.delete(key)
        }
      }
    }
  }
}

function memoryRegistry(): ClientProfileSecretNameRegistry & { names: Map<string, string[]> } {
  const names = new Map<string, string[]>()
  return {
    names,
    listSecretNames: (id) => [...(names.get(id) ?? [])],
    recordSecretName: (id, name) => {
      names.set(id, [...new Set([...(names.get(id) ?? []), name])])
    },
    forgetSecretName: (id, name) => {
      names.set(
        id,
        (names.get(id) ?? []).filter((item) => item !== name)
      )
    }
  }
}

describe('ClientProfileKeychain', () => {
  it('stores under the fixed service and per-profile account, recording names only', () => {
    const { backend, store } = memoryKeyring()
    const registry = memoryRegistry()
    const keychain = new ClientProfileKeychain(registry, () => backend)
    keychain.setSecret('acme', 'GH_TOKEN', 'fixture-value')
    expect(store.get(`${CLIENT_PROFILE_KEYCHAIN_SERVICE}|client-profile/acme/GH_TOKEN`)).toBe(
      'fixture-value'
    )
    expect(registry.names.get('acme')).toEqual(['GH_TOKEN'])
    expect(keychain.getSecret('acme', 'GH_TOKEN')).toBe('fixture-value')
    expect(keychain.status('acme', ['GH_TOKEN', 'SUPABASE_ACCESS_TOKEN'])).toEqual({
      GH_TOKEN: 'set',
      SUPABASE_ACCESS_TOKEN: 'missing'
    })
  })

  it('deleteAll removes every recorded name and leaves other profiles alone', () => {
    const { backend, store } = memoryKeyring()
    const registry = memoryRegistry()
    const keychain = new ClientProfileKeychain(registry, () => backend)
    keychain.setSecret('acme', 'GH_TOKEN', 'a')
    keychain.setSecret('acme', 'SUPABASE_ACCESS_TOKEN', 'b')
    keychain.setSecret('contoso', 'GH_TOKEN', 'c')
    keychain.deleteAll('acme')
    expect([...store.keys()]).toEqual([
      `${CLIENT_PROFILE_KEYCHAIN_SERVICE}|client-profile/contoso/GH_TOKEN`
    ])
    expect(registry.names.get('acme')).toEqual([])
  })

  it('fails closed when the native module cannot load (no fallback)', () => {
    const keychain = new ClientProfileKeychain(memoryRegistry(), () => {
      throw new Error('module missing')
    })
    expect(keychain.isAvailable()).toBe(false)
    expect(() => keychain.getSecret('acme', 'GH_TOKEN')).toThrow(
      ClientProfileKeychainUnavailableError
    )
    expect(() => keychain.setSecret('acme', 'GH_TOKEN', 'x')).toThrow(
      ClientProfileKeychainUnavailableError
    )
    expect(keychain.status('acme', ['GH_TOKEN'])).toEqual({ GH_TOKEN: 'unknown' })
  })

  it('rejects multi-line or oversized values and bad names without echoing the value', () => {
    const keychain = new ClientProfileKeychain(memoryRegistry(), () => memoryKeyring().backend)
    expect(() => keychain.setSecret('acme', 'GH_TOKEN', 'line1\nline2')).toThrow(
      /one non-empty line/
    )
    expect(() => keychain.setSecret('acme', 'GH_TOKEN', 'x'.repeat(2000))).toThrow(/at most/)
    expect(() => clientProfileKeychainAccount('acme', 'gh token')).toThrow(/invalid/)
    expect(() => clientProfileKeychainAccount('../x', 'GH_TOKEN')).toThrow(/invalid/)
  })

  it('treats a NoEntry error as a missing secret', () => {
    const keychain = new ClientProfileKeychain(memoryRegistry(), () => ({
      createEntry: () => ({
        getPassword: () => {
          throw new Error('NoEntry')
        },
        setPassword: () => {},
        deletePassword: () => false
      })
    }))
    expect(keychain.getSecret('acme', 'GH_TOKEN')).toBeNull()
  })

  it('exposes the design §2 module API over the installed instance', () => {
    const registry = memoryRegistry()
    installClientProfileKeychain(new ClientProfileKeychain(registry, () => memoryKeyring().backend))
    try {
      setSecret('acme', 'GH_TOKEN', 'fixture-value')
      expect(getSecret('acme', 'GH_TOKEN')).toBe('fixture-value')
      expect(status('acme')).toEqual({ GH_TOKEN: 'set' })
      deleteAll('acme')
      expect(getSecret('acme', 'GH_TOKEN')).toBeNull()
    } finally {
      installClientProfileKeychain(null)
    }
    expect(() => getSecret('acme', 'GH_TOKEN')).toThrow(ClientProfileKeychainUnavailableError)
  })

  it('accepts only a `.test` namespace of its own service as an override', () => {
    const smoke = `${CLIENT_PROFILE_KEYCHAIN_SERVICE}.test-smoke`
    expect(resolveClientProfileKeychainService({ AIBORG_KEYCHAIN_SERVICE: smoke })).toBe(smoke)
    expect(resolveClientProfileKeychainService({ AIBORG_KEYCHAIN_SERVICE: 'other-app' })).toBe(
      CLIENT_PROFILE_KEYCHAIN_SERVICE
    )
    expect(resolveClientProfileKeychainService({})).toBe(CLIENT_PROFILE_KEYCHAIN_SERVICE)
    const { backend, store } = memoryKeyring()
    new ClientProfileKeychain(memoryRegistry(), () => backend, { service: smoke }).setSecret(
      'acme',
      'GH_TOKEN',
      'fixture-value'
    )
    expect([...store.keys()]).toEqual([`${smoke}|client-profile/acme/GH_TOKEN`])
  })
})
