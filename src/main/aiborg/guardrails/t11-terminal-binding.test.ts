// T11 (design §4.1, invariant 3). Needs the Phase 2 implementation.
// Defined here where the design is silent: a binding is keyed by the spawn's session id (stable
// across daemon restarts), recorded at spawn time and persisted in the sidecar's ptyBindings.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACME,
  CONTOSO,
  FIXTURE_SECRETS,
  isRecord,
  readJsonLines
} from './client-profile-test-fixtures'
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

describe('T11 terminal binding', () => {
  let world: ClientProfileWorld

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: CONTOSO })
  })

  afterEach(async () => world.dispose())

  const refusalsLogged = (): number =>
    [ACME, CONTOSO]
      .map((id) => join(world.profileHome(id), 'audit.jsonl'))
      .filter((path) => existsSync(path))
      .flatMap((path) => readJsonLines(path))
      .filter((line) => line.event === 'terminal.refused').length

  it('refuses a renderer spawn of an acme repo while contoso is active, and audits it', async () => {
    await expect(rendererSpawn({ worktreeId: world.worktreeIds.acme, env: {} })).rejects.toThrow()
    expect(refusalsLogged()).toBe(1)
  })

  it('runs a headless spawn of the same repo as acme', async () => {
    const result = await headlessSpawn({
      worktreeId: world.worktreeIds.acme,
      env: {}
    })
    expect(result.env.AIBORG_PROFILE_ID).toBe(ACME)
    expect(result.env.GH_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
  })

  it('pins floating terminals and unbound repos to the active profile', async () => {
    expect((await rendererSpawn({ env: {} })).env.AIBORG_PROFILE_ID).toBe(CONTOSO)
    expect(
      (await rendererSpawn({ worktreeId: world.worktreeIds.unbound, env: {} })).env
        .AIBORG_PROFILE_ID
    ).toBe(CONTOSO)
    await clientProfiles.activate(ACME)
    expect((await rendererSpawn({ env: {} })).env.AIBORG_PROFILE_ID).toBe(ACME)
  })

  it('keeps a terminal on acme across a switch: binding, reattach and cold restore', async () => {
    await clientProfiles.activate(ACME)
    const sessionId = `${world.worktreeIds.acme}@@0a1b2c3d`
    await rendererSpawn({
      worktreeId: world.worktreeIds.acme,
      sessionId,
      env: {}
    })
    expect(clientProfiles.ptyBinding(sessionId)).toBe(ACME)

    await clientProfiles.activate(CONTOSO)
    // Reattach sends no env, so only the binding (and the border it drives) can change: it must not.
    expect(clientProfiles.ptyBinding(sessionId)).toBe(ACME)
    const sidecar = world.sandbox.readSidecar()
    expect(isRecord(sidecar.ptyBindings) ? sidecar.ptyBindings[sessionId] : undefined).toBe(ACME)

    // Cold restore re-resolves from the worktree: headless keeps acme, a renderer restore is refused.
    const restored = await headlessSpawn({
      worktreeId: world.worktreeIds.acme,
      sessionId,
      env: {}
    })
    expect(restored.env.AIBORG_PROFILE_ID).toBe(ACME)
    await expect(
      rendererSpawn({ worktreeId: world.worktreeIds.acme, sessionId, env: {} })
    ).rejects.toThrow()
    expect(clientProfiles.ptyBinding(sessionId)).toBe(ACME)
  })

  it('reattaches live acme and floating terminals after a relaunch under contoso', async () => {
    await clientProfiles.activate(ACME)
    const bound = `${world.worktreeIds.acme}@@1c2d3e4f`
    const floating = 'floating@@5a6b7c8d'
    await rendererSpawn({ worktreeId: world.worktreeIds.acme, sessionId: bound, env: {} })
    await rendererSpawn({ sessionId: floating, env: {} })
    await clientProfiles.activate(CONTOSO)

    const live = [bound, floating]
    const reattachedBound = await rendererSpawn({
      worktreeId: world.worktreeIds.acme,
      sessionId: bound,
      env: {},
      liveSessionIds: live
    })
    const reattachedFloating = await rendererSpawn({
      sessionId: floating,
      env: {},
      liveSessionIds: live
    })
    expect(reattachedBound.env.AIBORG_PROFILE_ID).toBe(ACME)
    expect(reattachedFloating.env.AIBORG_PROFILE_ID).toBe(ACME)
    expect(clientProfiles.ptyBinding(bound)).toBe(ACME)
    expect(clientProfiles.ptyBinding(floating)).toBe(ACME)
    expect(refusalsLogged()).toBe(0)

    // Once the floating session is gone, a restore of it follows the active profile.
    expect((await rendererSpawn({ sessionId: floating, env: {} })).env.AIBORG_PROFILE_ID).toBe(
      CONTOSO
    )
  })

  it('never rebinds a running terminal when the active profile changes', async () => {
    const sessionId = `${world.worktreeIds.contoso}@@99887766`
    await rendererSpawn({
      worktreeId: world.worktreeIds.contoso,
      sessionId,
      env: {}
    })
    await clientProfiles.activate(ACME)
    await clientProfiles.activate(null)
    expect(clientProfiles.ptyBinding(sessionId)).toBe(CONTOSO)
  })
})
