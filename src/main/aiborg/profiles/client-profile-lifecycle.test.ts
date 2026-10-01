import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KeyringBackend } from '../keychain/client-profile-keychain'
import { buildClientProfilesState } from '../ipc/client-profile-state'
import {
  activateClientProfile,
  deleteClientProfile,
  saveClientProfile,
  setClientProfileLifecycleHooks
} from './client-profile-lifecycle'
import {
  initClientProfileRuntime,
  resetClientProfileRuntimeForTests,
  type ClientProfileRuntime
} from './client-profile-runtime'
import {
  getActiveClientProfile,
  getClientProfileLayout
} from '../binding/client-profile-core-access'

let dir = ''
let rt: ClientProfileRuntime
let keyring: Map<string, string>

const memoryBackend = (): KeyringBackend => ({
  createEntry: (service, account) => ({
    getPassword: () => keyring.get(`${service}|${account}`) ?? null,
    setPassword: (value) => {
      keyring.set(`${service}|${account}`, value)
    },
    deletePassword: () => keyring.delete(`${service}|${account}`)
  })
})

function draft(id: string, orgs: string[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    name: id === 'acme' ? 'Acme' : 'Contoso',
    color: '#2F80ED',
    github: { allowedOrgs: orgs },
    git: { userName: 'Example Name', userEmail: `dev@${id}.example` },
    secrets: { GH_TOKEN: { bitwarden: `${id} / GitHub` } }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiborg-lifecycle-'))
  mkdirSync(join(dir, 'clients'))
  keyring = new Map()
  rt = initClientProfileRuntime({
    userDataPath: join(dir, 'userData'),
    env: { AIBORG_PROFILES_DIR: join(dir, 'clients'), AIBORG_PROFILES_ROOT: join(dir, 'profiles') },
    home: join(dir, 'home'),
    loadKeyringBackend: memoryBackend
  })
  setClientProfileLifecycleHooks({ readGitVersion: async () => 'git version 2.45.0' })
})

afterEach(() => {
  resetClientProfileRuntimeForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('save, activate, delete', () => {
  it('creates a profile, generates P and audits profile.create', async () => {
    expect(await saveClientProfile(draft('acme', ['acme-inc']))).toEqual({ ok: true })
    expect(existsSync(join(dir, 'clients', 'acme.json'))).toBe(true)
    expect(existsSync(join(dir, 'profiles', 'acme', 'hooks', 'pre-push'))).toBe(true)
    expect(readFileSync(join(dir, 'profiles', 'acme', 'audit.jsonl'), 'utf8')).toContain(
      '"event":"profile.create"'
    )
  })

  it('refuses duplicate ids, id changes and orgs already claimed', async () => {
    await saveClientProfile(draft('acme', ['acme-inc']))
    expect(await saveClientProfile(draft('acme', ['acme-inc']))).toMatchObject({ ok: false })
    expect(await saveClientProfile(draft('contoso', ['contoso-org']), 'acme')).toMatchObject({
      ok: false
    })
    const claimed = await saveClientProfile(draft('contoso', ['acme-inc']))
    expect(claimed.ok === false && claimed.errors.join()).toMatch(/already listed/)
  })

  it('activates and switches to personal mode without relaunch', async () => {
    await saveClientProfile(draft('acme', ['acme-inc']))
    await activateClientProfile('acme')
    expect(getActiveClientProfile()?.id).toBe('acme')
    expect(getClientProfileLayout('acme').claude).toBe(join(dir, 'profiles', 'acme', 'claude'))
    await activateClientProfile(null)
    expect(rt.sidecar.read().activeProfileId).toBeNull()
    const audit = readFileSync(join(dir, 'profiles', 'acme', 'audit.jsonl'), 'utf8')
    expect(audit).toContain('"event":"profile.activate"')
    expect(audit).toContain('"event":"profile.deactivate"')
  })

  it('fails activation closed when the keychain or git is not usable', async () => {
    await saveClientProfile(draft('acme', ['acme-inc']))
    setClientProfileLifecycleHooks({ readGitVersion: async () => 'git version 2.30.1' })
    await expect(activateClientProfile('acme')).rejects.toThrow(/git 2.32/)
    resetClientProfileRuntimeForTests()
    initClientProfileRuntime({
      userDataPath: join(dir, 'userData'),
      env: {
        AIBORG_PROFILES_DIR: join(dir, 'clients'),
        AIBORG_PROFILES_ROOT: join(dir, 'profiles')
      },
      loadKeyringBackend: () => {
        throw new Error('no keyring')
      }
    })
    await expect(activateClientProfile('acme')).rejects.toThrow(/keychain is unavailable/)
  })

  it('deletes P, keychain entries and bindings, archiving the audit log', async () => {
    await saveClientProfile(draft('acme', ['acme-inc']))
    rt.keychain.setSecret('acme', 'GH_TOKEN', 'fixture-secret-value')
    rt.sidecar.setRepoBinding('repo-1', 'acme')
    expect(
      await deleteClientProfile({ profileId: 'acme', confirmId: 'acm', deleteJson: false })
    ).toMatchObject({
      reason: 'confirm-mismatch'
    })
    setClientProfileLifecycleHooks({ isProfileInUse: () => true })
    expect(
      await deleteClientProfile({ profileId: 'acme', confirmId: 'acme', deleteJson: false })
    ).toMatchObject({
      reason: 'in-use'
    })
    setClientProfileLifecycleHooks({ isProfileInUse: () => false })
    expect(
      await deleteClientProfile({ profileId: 'acme', confirmId: 'acme', deleteJson: true })
    ).toEqual({ ok: true })
    expect(existsSync(join(dir, 'profiles', 'acme'))).toBe(false)
    expect(keyring.size).toBe(0)
    expect(rt.sidecar.read()).toMatchObject({ repoBindings: {}, storedSecretNames: {} })
    expect(existsSync(join(dir, 'clients', 'acme.json'))).toBe(false)
    const archived = readdirSync(join(dir, 'audit-archive'))
    expect(archived).toHaveLength(1)
    const archiveText = readFileSync(join(dir, 'audit-archive', archived[0]), 'utf8')
    expect(archiveText).toContain('"event":"profile.delete"')
    expect(archiveText).not.toContain('fixture-secret-value')
  })
})

describe('renderer state', () => {
  it('exposes secret status but never secret values', async () => {
    await saveClientProfile(draft('acme', ['acme-inc']))
    writeFileSync(join(dir, 'clients', 'contoso.json'), '{"schemaVersion":1}')
    rt.store.reload()
    rt.keychain.setSecret('acme', 'GH_TOKEN', 'fixture-secret-value')
    const state = buildClientProfilesState(rt)
    expect(state).toMatchObject({
      enabled: true,
      profilesDirSource: 'env',
      keychainAvailable: true
    })
    expect(state.profiles.find((p) => p.id === 'acme')?.secretStatus).toEqual({ GH_TOKEN: 'set' })
    expect(state.profiles.find((p) => p.id === 'contoso')?.errors.length).toBeGreaterThan(0)
    expect(JSON.stringify(state)).not.toContain('fixture-secret-value')
  })
})
