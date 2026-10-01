// T13 (design §4.2, invariant 4: H30/H33/H34/H48). Needs the Phase 2 implementation.
// Defined here where the design is silent: in personal mode a record homed in a profile's
// directory is refused too (it would run that client's login under personal env).
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { createClaudeStructuredLaunchResolver } from '../../claude/claude-structured-launch-resolution'
import { createCodexStructuredLaunchResolver } from '../../codex/codex-structured-launch-resolution'
import { isAgentSessionPreSpawnError } from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { ACME, CONTOSO } from './client-profile-test-fixtures'
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

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both resolvers read only identity.sessionId before the guard runs.
const IDENTITY = { sessionId: 'guardrail-session' } as Parameters<
  ReturnType<typeof createClaudeStructuredLaunchResolver>
>[0]['identity']

function record(
  provider: 'claude' | 'codex',
  workspaceId: string,
  accountHome: string
): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch resolvers read only these record fields before the guard.
  return {
    sessionId: IDENTITY.sessionId,
    provider,
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId,
      workspaceKind: 'worktree'
    },
    accountHome: {
      variable: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: accountHome
    },
    providerHandleChain: []
  } as unknown as AgentSessionRecord
}

function storeWith(value: AgentSessionRecord): AgentSessionRecordStore {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolvers only call getRecord.
  return { getRecord: () => value } as unknown as AgentSessionRecordStore
}

async function expectPreSpawnRefusal(run: () => unknown): Promise<void> {
  let caught: unknown
  try {
    await run()
  } catch (error) {
    caught = error
  }
  expect(isAgentSessionPreSpawnError(caught)).toBe(true)
}

describe('T13 structured-session guard', () => {
  let world: ClientProfileWorld
  let home: (id: string, tool: 'claude' | 'codex') => string

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: ACME })
    home = (id, tool) => join(world.profileHome(id), tool)
  })

  afterEach(async () => world.dispose())

  it('allows a record homed in its own worktree profile', () => {
    for (const provider of ['claude', 'codex'] as const) {
      expect(() =>
        clientProfiles.assertAccountHome({
          provider,
          workspaceId: world.worktreeIds.acme,
          accountHomePath: home(ACME, provider)
        })
      ).not.toThrow()
    }
  })

  it.each(['claude', 'codex'] as const)(
    '%s: refuses an acme record restarted in a contoso worktree',
    async (provider) => {
      await expectPreSpawnRefusal(() =>
        clientProfiles.assertAccountHome({
          provider,
          workspaceId: world.worktreeIds.contoso,
          accountHomePath: home(ACME, provider)
        })
      )
    }
  )

  it('refuses a pre-profile ~/.claude or ~/.codex record under a profile', async () => {
    await expectPreSpawnRefusal(() =>
      clientProfiles.assertAccountHome({
        provider: 'claude',
        workspaceId: world.worktreeIds.acme,
        accountHomePath: join(homedir(), '.claude')
      })
    )
    await expectPreSpawnRefusal(() =>
      clientProfiles.assertAccountHome({
        provider: 'codex',
        workspaceId: world.worktreeIds.acme,
        accountHomePath: join(homedir(), '.codex')
      })
    )
  })

  it('refuses adopting or resuming a transcript that lives in another profile’s home', async () => {
    await expectPreSpawnRefusal(() =>
      clientProfiles.assertAccountHome({
        provider: 'claude',
        workspaceId: world.worktreeIds.acme,
        accountHomePath: home(CONTOSO, 'claude')
      })
    )
  })

  it('personal mode: an unbound worktree keeps ~/.claude but refuses a profile home', async () => {
    await clientProfiles.activate(null)
    expect(() =>
      clientProfiles.assertAccountHome({
        provider: 'claude',
        workspaceId: world.worktreeIds.unbound,
        accountHomePath: join(homedir(), '.claude')
      })
    ).not.toThrow()
    await expectPreSpawnRefusal(() =>
      clientProfiles.assertAccountHome({
        provider: 'claude',
        workspaceId: world.worktreeIds.unbound,
        accountHomePath: home(ACME, 'claude')
      })
    )
  })

  it('Claude launch resolver (H33) refuses before any spawn data is built', async () => {
    const resolve = createClaudeStructuredLaunchResolver({
      store: storeWith(record('claude', world.worktreeIds.contoso, home(ACME, 'claude'))),
      resolveWorkspacePath: async () => world.repos.contoso.path,
      resolveCommand: () => join(world.sandbox.root, 'bin', 'claude'),
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveInheritedEnv: async () => ({ PATH: '/usr/bin' }),
      hasTranscript: async () => false,
      ...clientProfiles.claudeResolverGuardDeps()
    })
    await expectPreSpawnRefusal(() => resolve({ identity: IDENTITY }))
  })

  it('Codex launch resolver (H34) refuses before any spawn data is built', async () => {
    const resolve = createCodexStructuredLaunchResolver({
      store: storeWith(record('codex', world.worktreeIds.contoso, home(ACME, 'codex'))),
      resolveWorkspacePath: async () => world.repos.contoso.path,
      resolveCommand: () => join(world.sandbox.root, 'bin', 'codex'),
      isWindowsProcessStartTimeAvailable: () => true,
      resolveEnvironment: async () => ({ PATH: '/usr/bin' })
    })
    await expectPreSpawnRefusal(() => resolve({ identity: IDENTITY }))
  })

  it('terminal Codex resume (H48) only accepts the worktree profile’s Codex home', async () => {
    const ok = await rendererSpawn({
      worktreeId: world.worktreeIds.acme,
      codexResumeHome: home(ACME, 'codex'),
      daemon: false,
      env: {}
    })
    expect(ok.env.AIBORG_PROFILE_ID).toBe(ACME)
    for (const foreign of [home(CONTOSO, 'codex'), join(homedir(), '.codex')]) {
      await expect(
        rendererSpawn({
          worktreeId: world.worktreeIds.acme,
          codexResumeHome: foreign,
          daemon: false,
          env: {}
        })
      ).rejects.toThrow()
    }
  })
})
