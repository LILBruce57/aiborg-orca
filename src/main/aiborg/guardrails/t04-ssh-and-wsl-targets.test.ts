// T4 (design §3.4, invariant 5). Needs the Phase 2 implementation.
// Decided for v1: WSL profile-bound spawns, scripts and text generation are refused with a message naming WSL.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACME,
  ALL_FIXTURE_SECRET_VALUES,
  FIXTURE_SECRETS,
  acmeProfileJson,
  contosoProfileJson,
  envKeysMentioning
} from './client-profile-test-fixtures'
import {
  createClientProfileSandbox,
  type ClientProfileSandbox
} from './client-profile-sandbox-test-fixture'
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

const SPAWNS = [
  ['renderer', rendererSpawn],
  ['headless', headlessSpawn]
] as const

describe('T4 SSH target env (pure builder)', () => {
  let sandbox: ClientProfileSandbox

  afterEach(() => sandbox.dispose())

  const sshEnv = (envAllowlist: string[]) => {
    const acme = clientProfiles.profileFrom(
      acmeProfileJson({ remote: { allow: true, envAllowlist } })
    )
    return clientProfiles.buildEnv(
      acme,
      { ...FIXTURE_SECRETS.acme },
      { kind: 'ssh', connectionId: 'ssh-fixture' },
      {
        platform: process.platform,
        allProfiles: [acme, clientProfiles.profileFrom(contosoProfileJson())],
        basePath: '/usr/bin'
      }
    )
  }

  it('sends only AIBORG_PROFILE_*, allowlisted keys and the managed deletes; never paths or secrets', () => {
    sandbox = createClientProfileSandbox()
    const built = sshEnv(['ACME_STAGE'])
    for (const key of Object.keys(built.set)) {
      expect(key.startsWith('AIBORG_PROFILE_') || key === 'ACME_STAGE', key).toBe(true)
    }
    expect(built.set.AIBORG_PROFILE_ID).toBe(ACME)
    expect(built.set.ACME_STAGE).toBe('acme-stage-dev')
    expect(envKeysMentioning(built.set, [...ALL_FIXTURE_SECRET_VALUES, sandbox.root])).toEqual([])
    expect(built.delete).toEqual(
      expect.arrayContaining(['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY'])
    )
  })

  it('cannot be made to export a keychain secret or a local path through the allowlist', () => {
    sandbox = createClientProfileSandbox()
    const raw = acmeProfileJson({
      remote: {
        allow: true,
        envAllowlist: ['ACME_STAGE', 'GH_TOKEN', 'CLAUDE_CONFIG_DIR']
      }
    })
    // Either the schema refuses such an allowlist, or the builder ignores those keys.
    if (clientProfiles.validateProfile(raw, 'acme.json').ok) {
      const built = sshEnv(['ACME_STAGE', 'GH_TOKEN', 'CLAUDE_CONFIG_DIR'])
      expect(built.set.GH_TOKEN).toBeUndefined()
      expect(built.set.CLAUDE_CONFIG_DIR).toBeUndefined()
      expect(envKeysMentioning(built.set, [...ALL_FIXTURE_SECRET_VALUES, sandbox.root])).toEqual([])
    }
  })
})

describe('T4 SSH and WSL spawns', () => {
  let world: ClientProfileWorld

  afterEach(async () => world.dispose())

  it.each(SPAWNS)(
    '%s: refuses a profile-bound SSH spawn unless remote.allow',
    async (_label, spawn) => {
      world = await createClientProfileWorld({ active: ACME })
      await expect(
        spawn({
          worktreeId: world.worktreeIds.acme,
          connectionId: 'ssh-fixture',
          env: {}
        })
      ).rejects.toThrow()
    }
  )

  it.each(SPAWNS)(
    '%s: an allowed SSH spawn carries no local path or secret',
    async (_label, spawn) => {
      world = await createClientProfileWorld({ active: ACME })
      world.sandbox.writeProfile(
        acmeProfileJson({
          remote: { allow: true, envAllowlist: ['ACME_STAGE'] }
        })
      )
      await clientProfiles.init()
      const result = await spawn({
        worktreeId: world.worktreeIds.acme,
        connectionId: 'ssh-fixture',
        env: {}
      })
      expect(result.env.AIBORG_PROFILE_ID).toBe(ACME)
      expect(result.env.ACME_STAGE).toBe('acme-stage-dev')
      expect(
        envKeysMentioning(result.env, [...ALL_FIXTURE_SECRET_VALUES, world.sandbox.root])
      ).toEqual([])
      for (const key of [
        'GIT_CONFIG_GLOBAL',
        'GH_TOKEN',
        'CLAUDE_CONFIG_DIR',
        'CODEX_HOME',
        'AWS_CONFIG_FILE'
      ]) {
        expect(result.env[key], key).toBeUndefined()
      }
      expect(result.envToDelete).toEqual(expect.arrayContaining(['GH_TOKEN', 'GITHUB_TOKEN']))
    }
  )

  it.each(SPAWNS)('%s: refuses every profile-bound WSL spawn', async (_label, spawn) => {
    world = await createClientProfileWorld({ active: ACME })
    await expect(
      spawn({
        worktreeId: world.worktreeIds.acme,
        wslDistro: 'Ubuntu',
        env: {}
      })
    ).rejects.toThrow(/WSL/i)
  })

  it('refuses WSL orca.yaml scripts and text generation for a profile-bound repo (H25/H26)', async () => {
    world = await createClientProfileWorld({ active: ACME })
    const base = { PATH: '/usr/bin', KEEP: '1' }
    expect(() =>
      clientProfiles.scriptEnv({
        cwd: world.repos.acme.path,
        worktreeId: world.worktreeIds.acme,
        wslDistro: 'Ubuntu',
        baseEnv: base
      })
    ).toThrow(/WSL/i)
    const native = clientProfiles.scriptEnv({
      cwd: world.repos.acme.path,
      worktreeId: world.worktreeIds.acme,
      wslDistro: null,
      baseEnv: base
    })
    expect(native.AIBORG_PROFILE_ID).toBe(ACME)
    expect(native.GH_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
    expect(native.KEEP).toBe('1')
  })

  it('leaves WSL scripts of an unbound repo alone in personal mode', async () => {
    world = await createClientProfileWorld({ active: null })
    const base = { PATH: '/usr/bin', KEEP: '1' }
    expect(
      clientProfiles.scriptEnv({
        cwd: world.repos.unbound.path,
        worktreeId: world.worktreeIds.unbound,
        wslDistro: 'Ubuntu',
        baseEnv: base
      })
    ).toEqual(base)
  })
})
