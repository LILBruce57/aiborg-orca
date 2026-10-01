// T20 (design §3.2 "Structured sessions", H23/H24/H31). Drives the real launch resolvers through
// the real session adapters (fake provider connections), then the real connection env builders,
// so a delete list dropped anywhere between resolver and child fails here. Needs the Phase 2 implementation.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { spawnProcess } from '../../../shared/child-process/run-process'
import { createClaudeStructuredLaunchResolver } from '../../claude/claude-structured-launch-resolution'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  PROVIDER_SESSION_ID,
  fakeClaude,
  identityFor as claudeIdentityFor
} from '../../claude/claude-structured-session-test-support'
import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonLaunch
} from '../../claude/claude-stream-json-connection'
import {
  openCodexAppServerConnection,
  type CodexAppServerLaunch
} from '../../codex/codex-app-server-connection'
import { createCodexStructuredLaunchResolver } from '../../codex/codex-structured-launch-resolution'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import {
  fakeCodex,
  identityFor as codexIdentityFor
} from '../../codex/codex-structured-session-adapter-fixture'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  ACME,
  AMBIENT_PERSONAL_ENV,
  FIXTURE_SECRETS,
  comparablePath,
  envKeysMentioning
} from './client-profile-test-fixtures'
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

/** The login-shell snapshot structured sessions start from (structured-agent-shell-environment.ts). */
const SHELL_SNAPSHOT = {
  PATH: process.env.PATH ?? '/usr/bin',
  GITHUB_TOKEN: 'ambient-shell-github-token',
  GH_TOKEN: 'ambient-shell-gh-token',
  AWS_ACCESS_KEY_ID: 'ambient-shell-aws-id',
  AWS_SECRET_ACCESS_KEY: 'ambient-shell-aws-secret',
  OPENAI_API_KEY: 'ambient-shell-openai',
  ANTHROPIC_API_KEY: 'ambient-shell-anthropic'
}
const AMBIENT_VALUES = [
  ...Object.values(SHELL_SNAPSHOT).filter((value) => value.startsWith('ambient-')),
  ...Object.values(AMBIENT_PERSONAL_ENV)
]
const STRIPPED_KEYS = [
  'GITHUB_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY'
]

function storeWith(record: AgentSessionRecord): AgentSessionRecordStore {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launch resolution only calls getRecord.
  return { getRecord: () => record } as unknown as AgentSessionRecordStore
}

async function claudeChildEnv(launch: ClaudeStreamJsonLaunch): Promise<Record<string, string>> {
  let captured: Record<string, string> | undefined
  const capture = (input: { options?: { env?: Record<string, string> } }): never => {
    captured = input.options?.env
    throw new Error('captured')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the connection calls query once with { prompt, options } and the capture throws before using a result.
  const queryImpl = capture as unknown as Parameters<typeof openClaudeStreamJsonConnection>[3]
  await openClaudeStreamJsonConnection(launch, {}, undefined, queryImpl).catch(() => {})
  return captured ?? {}
}

async function codexChildEnv(launch: CodexAppServerLaunch): Promise<NodeJS.ProcessEnv> {
  let captured: NodeJS.ProcessEnv | undefined
  const capture = (spec: { env?: NodeJS.ProcessEnv }): never => {
    captured = spec.env
    throw new Error('captured')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the connection passes its spawn spec first and the capture throws before a child is needed.
  await openCodexAppServerConnection(launch, {}, capture as unknown as typeof spawnProcess).catch(
    () => {}
  )
  return captured ?? {}
}

describe('T20 structured env strip', () => {
  let world: ClientProfileWorld
  let P: string

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: ACME })
    P = world.profileHome(ACME)
  })

  afterEach(async () => world.dispose())

  const expectAcmeOnly = (env: Record<string, string | undefined>) => {
    for (const key of STRIPPED_KEYS) {
      expect(env[key], key).toBeUndefined()
    }
    expect(envKeysMentioning(env, AMBIENT_VALUES)).toEqual([])
    expect(env.GH_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
    expect(env.AIBORG_PROFILE_ID).toBe(ACME)
    expect(env.AWS_PROFILE).toBe('acme-dev')
  }

  it('structured Claude child under acme has none of the ambient credentials and acme’s values', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolver and adapter read only these record fields.
    const record = {
      sessionId: 'session-1',
      provider: 'claude',
      location: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: world.worktreeIds.acme,
        workspaceKind: 'worktree'
      },
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(P, 'claude') },
      providerHandleChain: [
        {
          handle: {
            provider: 'claude',
            sessionId: PROVIDER_SESSION_ID,
            leafUuid: null
          }
        }
      ]
    } as unknown as AgentSessionRecord
    const claude = fakeClaude()
    const adapter = new ClaudeStructuredSessionAdapter({
      resolveLaunch: createClaudeStructuredLaunchResolver({
        store: storeWith(record),
        resolveWorkspacePath: async () => world.repos.acme.path,
        resolveCommand: () => join(world.sandbox.root, 'bin', 'claude'),
        resolveAuthPolicy: () => ({ stripAuthEnv: false }),
        resolveInheritedEnv: async () => ({ ...SHELL_SNAPSHOT }),
        hasTranscript: async () => false,
        ...clientProfiles.claudeResolverGuardDeps()
      }),
      openConnection: claude.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      now: () => 1_700_000_000_500,
      persistHandle: async () => {}
    })
    await adapter
      .acquire({
        identity: claudeIdentityFor(),
        fence: 7,
        spawnToken: 'spawn-9'
      })
      .catch(() => {})

    expect(claude.connections).toHaveLength(1)
    const child = await claudeChildEnv(claude.connections[0].launch)
    expectAcmeOnly(child)
    expect(comparablePath(child.CLAUDE_CONFIG_DIR ?? '')).toBe(comparablePath(join(P, 'claude')))
  })

  it('structured Codex child under acme has none of the ambient credentials and acme’s values', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolver and adapter read only these record fields.
    const record = {
      sessionId: 'session-1',
      provider: 'codex',
      location: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: world.worktreeIds.acme,
        workspaceKind: 'worktree'
      },
      accountHome: { variable: 'CODEX_HOME', path: join(P, 'codex') },
      providerHandleChain: []
    } as unknown as AgentSessionRecord
    const codex = fakeCodex()
    let generation = 0
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: createCodexStructuredLaunchResolver({
        store: storeWith(record),
        resolveWorkspacePath: async () => world.repos.acme.path,
        resolveCommand: () => join(world.sandbox.root, 'bin', 'codex'),
        isWindowsProcessStartTimeAvailable: () => true,
        resolveEnvironment: async () => ({ ...SHELL_SNAPSHOT })
      }),
      onEvent: () => {},
      openConnection: codex.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      now: () => 1_700_000_000_500,
      mintAcquisitionGeneration: () => `generation-${++generation}`
    })
    await adapter
      .acquire({
        identity: codexIdentityFor('session-1'),
        fence: 7,
        spawnToken: 'spawn-9'
      })
      .catch(() => {})

    expect(codex.connections).toHaveLength(1)
    const child = await codexChildEnv(codex.connections[0].launch)
    expectAcmeOnly(child)
    expect(comparablePath(child.CODEX_HOME ?? '')).toBe(comparablePath(join(P, 'codex')))
  })
})
