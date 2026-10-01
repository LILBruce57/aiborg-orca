// T18 (design §2, invariant 7). `@napi-rs/keyring` is replaced by an in-memory fake.
// Decided for v1: service "be.aiborg.desktop.client-profiles", account "client-profile/<id>/<NAME>".
// Defined here where the design is silent: a keychain that fails after activation refuses the spawn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACME,
  ALL_FIXTURE_SECRET_VALUES,
  CONTOSO,
  FIXTURE_SECRETS,
  filesContaining,
  isRecord
} from './client-profile-test-fixtures'
import {
  CLIENT_PROFILE_KEYCHAIN_SERVICE,
  accountsForProfile,
  keychainAccount,
  keyringState,
  keyringValue
} from './client-profile-keyring-test-fixture'
import { safeStorageSpy } from './client-profile-electron-test-fixture'
import { clientProfiles } from './client-profile-test-harness'
import { headlessSpawn, rendererSpawn } from './client-profile-spawn-test-harness'
import {
  createClientProfileWorld,
  type ClientProfileWorld
} from './client-profile-world-test-harness'

vi.mock(
  'electron',
  async () => (await import('./client-profile-electron-test-fixture')).electronModule
)
vi.mock(
  '@napi-rs/keyring',
  async () => (await import('./client-profile-keyring-test-fixture')).keyringModule
)

describe('T18 keychain', () => {
  let world: ClientProfileWorld

  beforeEach(async () => {
    safeStorageSpy.encryptString.mockClear()
    world = await createClientProfileWorld({ active: null })
  })

  afterEach(async () => world.dispose())

  const storedNames = (id: string): unknown => {
    const names = world.sandbox.readSidecar().storedSecretNames
    return isRecord(names) ? (names[id] ?? []) : []
  }

  it('stores each secret as its own entry under the decided service and account', async () => {
    expect(keyringValue(ACME, 'GH_TOKEN')).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
    expect(
      keyringState.calls.some(
        (call) =>
          call.op === 'set' &&
          call.service === CLIENT_PROFILE_KEYCHAIN_SERVICE &&
          call.account === keychainAccount(ACME, 'GH_TOKEN')
      )
    ).toBe(true)
    expect(await clientProfiles.keychain.getSecret(ACME, 'GH_TOKEN')).toBe(
      FIXTURE_SECRETS.acme.GH_TOKEN
    )
    expect(storedNames(ACME)).toEqual(expect.arrayContaining(Object.keys(FIXTURE_SECRETS.acme)))
  })

  it('reports set or missing per name and never a value', async () => {
    await clientProfiles.keychain.deleteSecret(ACME, 'SUPABASE_ACCESS_TOKEN')
    const status = await clientProfiles.keychain.status(ACME)
    expect(status).toMatchObject({
      GH_TOKEN: 'set',
      ACME_SERVICE_TOKEN: 'set',
      SUPABASE_ACCESS_TOKEN: 'missing'
    })
    const serialized = JSON.stringify(status)
    for (const value of ALL_FIXTURE_SECRET_VALUES) {
      expect(serialized).not.toContain(value)
    }
  })

  it('deleteAll removes every recorded name, including ones the JSON no longer lists', async () => {
    await clientProfiles.keychain.setSecret(ACME, 'RETIRED_TOKEN', 'fixture-acme-retired-1a2b3c')
    await clientProfiles.keychain.deleteAll(ACME)
    expect(accountsForProfile(ACME)).toEqual([])
    expect(storedNames(ACME)).toEqual([])
    expect(keyringValue(CONTOSO, 'GH_TOKEN')).toBe(FIXTURE_SECRETS.contoso.GH_TOKEN)
  })

  it('fails activation when the keychain is unavailable, with no fallback anywhere', async () => {
    keyringState.unavailable = true
    await expect(clientProfiles.activate(ACME)).rejects.toThrow()
    expect(world.sandbox.readSidecar().activeProfileId ?? null).toBeNull()
    expect(safeStorageSpy.encryptString).not.toHaveBeenCalled()
    expect(filesContaining(world.sandbox.root, ALL_FIXTURE_SECRET_VALUES)).toEqual([])
    await expect(
      clientProfiles.keychain.setSecret(ACME, 'GH_TOKEN', 'fixture-acme-late-9e8d7c')
    ).rejects.toThrow()
    expect(filesContaining(world.sandbox.root, ['fixture-acme-late-9e8d7c'])).toEqual([])
  })

  it('refuses a profile spawn when the keychain fails after activation', async () => {
    await clientProfiles.activate(ACME)
    keyringState.unavailable = true
    await expect(rendererSpawn({ worktreeId: world.worktreeIds.acme, env: {} })).rejects.toThrow()
    await expect(headlessSpawn({ worktreeId: world.worktreeIds.acme, env: {} })).rejects.toThrow()
  })

  it('orcad (no keychain) refuses profile-bound spawns and still runs unbound ones', async () => {
    clientProfiles.useOrcadResolver()
    await expect(headlessSpawn({ worktreeId: world.worktreeIds.acme, env: {} })).rejects.toThrow()
    const floating = await headlessSpawn({ env: { KEEP: '1' } })
    expect(floating.env.KEEP).toBe('1')
    expect(floating.env.AIBORG_PROFILE_ID).toBeUndefined()
  })
})
