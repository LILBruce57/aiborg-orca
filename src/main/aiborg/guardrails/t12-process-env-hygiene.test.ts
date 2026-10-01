// T12 (design invariant 1). Needs the Phase 2 implementation.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACME,
  ALL_FIXTURE_SECRET_VALUES,
  CONTOSO,
  envKeysMentioning
} from './client-profile-test-fixtures'
import { clientProfiles } from './client-profile-test-harness'
import {
  daemonChildEnv,
  headlessSpawn,
  localProviderChildEnv,
  rendererSpawn
} from './client-profile-spawn-test-harness'
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

describe('T12 process.env hygiene', () => {
  let world: ClientProfileWorld

  afterEach(async () => world.dispose())

  it('leaves main’s process.env untouched by activation, spawns and agent env', async () => {
    world = await createClientProfileWorld({ active: null })
    const before = { ...process.env }

    await clientProfiles.activate(ACME)
    daemonChildEnv(await rendererSpawn({ worktreeId: world.worktreeIds.acme, env: {} }))
    await localProviderChildEnv(
      await headlessSpawn({
        worktreeId: world.worktreeIds.acme,
        env: {},
        daemon: false
      })
    )
    clientProfiles.agentEnv(world.worktreeIds.acme)
    clientProfiles.scriptEnv({
      cwd: world.repos.acme.path,
      worktreeId: world.worktreeIds.acme,
      baseEnv: {}
    })
    await clientProfiles.activate(CONTOSO)
    daemonChildEnv(await headlessSpawn({ worktreeId: world.worktreeIds.contoso, env: {} }))

    expect({ ...process.env }).toEqual(before)
    expect(Object.keys(process.env).filter((key) => key.startsWith('AIBORG_PROFILE_'))).toEqual([])
    expect(
      envKeysMentioning(process.env, [...ALL_FIXTURE_SECRET_VALUES, world.profileHome(ACME)])
    ).toEqual([])
  })
})
