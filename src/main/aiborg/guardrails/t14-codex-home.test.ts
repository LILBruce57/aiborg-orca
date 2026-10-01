// T14 (design §3.1 CODEX_HOME, §4 H32, LocalPtyProvider fallback). Needs the Phase 2 implementation.
// Also: with a profile active, structured Claude and Codex never resolve to the user's real home.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPtyHostEnv } from '../../ipc/pty/host-env/assembly'
import {
  resolveStructuredClaudeAccountHomePath,
  resolveStructuredCodexAccountHomePath
} from '../../runtime/structured-agent-account-home'
import { ACME, comparablePath } from './client-profile-test-fixtures'
import { clientProfiles } from './client-profile-test-harness'
import { rendererSpawn } from './client-profile-spawn-test-harness'
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

describe('T14 Codex home', () => {
  let world: ClientProfileWorld
  let acmeCodex: string

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: ACME })
    acmeCodex = join(world.profileHome(ACME), 'codex')
  })

  afterEach(async () => world.dispose())

  it('resolves a structured Codex home to P/codex without calling resolveLaunchHome (H32)', async () => {
    const resolveLaunchHome = vi.fn(async () =>
      join(world.sandbox.userData, 'codex-runtime-home', 'home')
    )
    const path = await resolveStructuredCodexAccountHomePath({
      launchEnv: clientProfiles.agentEnv(world.worktreeIds.acme).env,
      resolveLaunchHome
    })
    expect(comparablePath(path)).toBe(comparablePath(acmeCodex))
    expect(resolveLaunchHome).not.toHaveBeenCalled()
  })

  it('keeps the stock resolveLaunchHome route in personal mode', async () => {
    await clientProfiles.activate(null)
    const managed = join(world.sandbox.userData, 'codex-runtime-home', 'home')
    const resolveLaunchHome = vi.fn(async () => managed)
    const path = await resolveStructuredCodexAccountHomePath({
      launchEnv: clientProfiles.agentEnv(world.worktreeIds.unbound).env,
      resolveLaunchHome
    })
    expect(path).toBe(managed)
    expect(resolveLaunchHome).toHaveBeenCalledTimes(1)
  })

  it('never resolves structured Claude or Codex to the real home while a profile is active', async () => {
    const realClaude = comparablePath(join(homedir(), '.claude'))
    const realCodex = comparablePath(join(homedir(), '.codex'))
    for (const workspaceId of [world.worktreeIds.acme, world.worktreeIds.unbound]) {
      const launchEnv = clientProfiles.agentEnv(workspaceId).env
      const claude = resolveStructuredClaudeAccountHomePath({
        launchEnv,
        wslDistro: null,
        getClaudeConfigDirectory: () => join(homedir(), '.claude')
      })
      const codex = await resolveStructuredCodexAccountHomePath({
        launchEnv,
        resolveLaunchHome: async () => join(homedir(), '.codex')
      })
      expect(comparablePath(claude)).not.toBe(realClaude)
      expect(comparablePath(codex)).not.toBe(realCodex)
      expect(comparablePath(claude)).toBe(comparablePath(join(world.profileHome(ACME), 'claude')))
      expect(comparablePath(codex)).toBe(comparablePath(acmeCodex))
    }
  })

  it('ends the LocalPtyProvider fallback with CODEX_HOME = P/codex', async () => {
    const spawn = await rendererSpawn({
      worktreeId: world.worktreeIds.acme,
      daemon: false,
      env: {}
    })
    // What local-configure's buildSpawnEnv does after the merge (ARCHITECTURE-NOTES §3.1 exception).
    const env = buildPtyHostEnv(
      'guardrail-local',
      { ...spawn.env },
      {
        isPackaged: false,
        userDataPath: world.sandbox.userData,
        selectedCodexHomePath: spawn.codexHomePathOverride?.value ?? null,
        agentStatusHooksEnabled: false
      }
    )
    expect(comparablePath(env.CODEX_HOME)).toBe(comparablePath(acmeCodex))
    expect(comparablePath(env.ORCA_CODEX_HOME)).toBe(comparablePath(acmeCodex))
  })
})
