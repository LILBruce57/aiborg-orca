// T3 (design §4 H20/H21, §3.2, Phase 2 "done when"). Needs the Phase 2 implementation.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACME,
  AMBIENT_PERSONAL_ENV,
  CONTOSO,
  FIXTURE_SECRETS,
  comparablePath,
  envKeysMentioning,
  identifyingValues,
  pathKeys
} from './client-profile-test-fixtures'
import {
  daemonChildEnv,
  headlessSpawn,
  localProviderChildEnv,
  rendererSpawn,
  type SpawnRequest,
  type SpawnResult
} from './client-profile-spawn-test-harness'
import { clientProfiles } from './client-profile-test-harness'
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

const PROFILE_KEYS = [
  'AIBORG_PROFILE_ID',
  'GIT_CONFIG_GLOBAL',
  'GIT_SSH_COMMAND',
  'GH_TOKEN',
  'GH_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'ORCA_CODEX_HOME',
  'AWS_CONFIG_FILE',
  'AWS_PROFILE',
  'AZURE_CONFIG_DIR',
  'CLOUDSDK_CONFIG',
  'SUPABASE_ACCESS_TOKEN'
]

type SpawnPath = [label: string, spawn: (request: SpawnRequest) => Promise<SpawnResult>]
const SPAWN_PATHS: SpawnPath[] = [
  ['renderer (H20)', rendererSpawn],
  ['headless (H21)', headlessSpawn]
]

describe('T3 spawn hooks', () => {
  let world: ClientProfileWorld

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: ACME })
  })

  afterEach(async () => world.dispose())

  describe.each(SPAWN_PATHS)('%s', (_label, spawn) => {
    it('puts the profile values in spawnOptions.env and keeps them out of envToDelete', async () => {
      const result = await spawn({
        worktreeId: world.worktreeIds.acme,
        env: { CALLER: 'kept' }
      })
      for (const key of PROFILE_KEYS) {
        expect(result.env[key], key).toBeTruthy()
        expect(result.envToDelete, key).not.toContain(key)
      }
      expect(result.env.GH_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
      expect(result.env.CALLER).toBe('kept')
      expect(result.envToDelete).toEqual(
        expect.arrayContaining([
          'GITHUB_TOKEN',
          'OPENAI_API_KEY',
          'AWS_ACCESS_KEY_ID',
          'CONTOSO_STAGE'
        ])
      )
    })

    it('leaves spawnOptions.env pointing at the patched builder object', async () => {
      const result = await spawn({
        worktreeId: world.worktreeIds.acme,
        env: {}
      })
      expect(result.spawnOptions.env).toBe(result.ctxEnv)
      expect(result.ctxEnv.AIBORG_PROFILE_ID).toBe(ACME)
    })

    it('points the Codex home override at P/codex on the LocalPtyProvider path', async () => {
      const result = await spawn({
        worktreeId: world.worktreeIds.acme,
        env: {},
        daemon: false
      })
      expect(comparablePath(result.codexHomePathOverride?.value ?? '')).toBe(
        comparablePath(join(world.profileHome(ACME), 'codex'))
      )
    })
  })

  it.each([
    ['daemon', true],
    ['LocalPtyProvider fallback', false]
  ])('%s: an acme terminal has only acme values and no personal ones', async (_label, daemon) => {
    const spawn = await headlessSpawn({
      worktreeId: world.worktreeIds.acme,
      env: {},
      daemon
    })
    const child = daemon ? daemonChildEnv(spawn) : await localProviderChildEnv(spawn)
    const P = world.profileHome(ACME)
    expect(child.AIBORG_PROFILE_ID).toBe(ACME)
    expect(child.GH_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
    expect(child.SUPABASE_ACCESS_TOKEN).toBe(FIXTURE_SECRETS.acme.SUPABASE_ACCESS_TOKEN)
    expect(comparablePath(child.CLAUDE_CONFIG_DIR)).toBe(comparablePath(join(P, 'claude')))
    expect(comparablePath(child.CODEX_HOME)).toBe(comparablePath(join(P, 'codex')))
    expect(child.AWS_PROFILE).toBe('acme-dev')
    for (const key of [
      'GITHUB_TOKEN',
      'GH_HOST',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_DEFAULT_PROFILE',
      'GOOGLE_APPLICATION_CREDENTIALS'
    ]) {
      expect(child[key], key).toBeUndefined()
    }
    expect(envKeysMentioning(child, Object.values(AMBIENT_PERSONAL_ENV))).toEqual([])
    for (const key of pathKeys(child)) {
      expect(comparablePath(child[key].split(process.platform === 'win32' ? ';' : ':')[0])).toBe(
        comparablePath(join(P, 'bin'))
      )
    }
  })

  it('a contoso terminal carries none of acme’s values, and the reverse', async () => {
    await clientProfiles.activate(CONTOSO)
    const contosoChild = daemonChildEnv(
      await headlessSpawn({ worktreeId: world.worktreeIds.contoso, env: {} })
    )
    const acmeChild = daemonChildEnv(
      await headlessSpawn({ worktreeId: world.worktreeIds.acme, env: {} })
    )
    expect(contosoChild.AIBORG_PROFILE_ID).toBe(CONTOSO)
    expect(contosoChild.GH_TOKEN).toBe(FIXTURE_SECRETS.contoso.GH_TOKEN)
    expect(contosoChild.SUPABASE_ACCESS_TOKEN).toBeUndefined()
    expect(contosoChild.ACME_STAGE).toBeUndefined()
    expect(
      envKeysMentioning(contosoChild, [...identifyingValues(ACME), world.profileHome(ACME)])
    ).toEqual([])
    expect(
      envKeysMentioning(acmeChild, [...identifyingValues(CONTOSO), world.profileHome(CONTOSO)])
    ).toEqual([])
  })
})
