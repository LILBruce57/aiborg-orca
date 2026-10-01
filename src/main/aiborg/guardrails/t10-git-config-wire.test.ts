// T10 (design §3.1 GIT_CONFIG_*, §3.4, ARCHITECTURE-NOTES §3.1). Runs today against upstream code:
// the profile's command-scope git config (hooksPath, identity, pushInsteadOf) travels as caller-added
// GIT_CONFIG_* keys, so they must survive every merge and credential guard on the way to the shell.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonPtyEnvironment } from '../../daemon/pty-subprocess/spawn-environment'
import { mergeGitConfigEnvProtocol } from '../../../shared/git-credential-prompt-env'
import {
  TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV,
  applyTerminalGitCredentialPromptGuard
} from '../../../shared/terminal-git-credential-guard'

const PROFILE_ENTRIES: [string, string][] = [
  ['core.hooksPath', '/fixture/profiles/acme/hooks'],
  ['user.email', 'dev@acme.example'],
  ['url.aiborg-blocked://.pushInsteadOf', 'https://github.com/'],
  ['url.https://github.com/acme-inc/.pushInsteadOf', 'https://github.com/acme-inc/']
]

function protocolEnv(entries: readonly (readonly [string, string])[]): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length)
  }
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

function entriesOf(env: Record<string, string | undefined>): [string, string][] {
  const count = Number(env.GIT_CONFIG_COUNT ?? '0')
  return Array.from({ length: count }, (_, index): [string, string] => [
    env[`GIT_CONFIG_KEY_${index}`] ?? '<missing>',
    env[`GIT_CONFIG_VALUE_${index}`] ?? '<missing>'
  ])
}

afterEach(() => vi.unstubAllEnvs())

describe('T10 git-config wire', () => {
  it('daemon: caller entries replace the daemon’s inherited set atomically and survive intact', () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'daemon.inherited')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'stale')
    const env = createDaemonPtyEnvironment({
      sessionId: 'wire',
      cols: 80,
      rows: 24,
      env: protocolEnv(PROFILE_ENTRIES)
    })
    expect(entriesOf(env)).toEqual(PROFILE_ENTRIES)
  })

  it.each([
    ['an agent launch', { launchAgent: 'claude' as const, env: protocolEnv(PROFILE_ENTRIES) }],
    [
      'the deferred guard policy',
      {
        env: {
          ...protocolEnv(PROFILE_ENTRIES),
          [TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]: 'guard'
        }
      }
    ]
  ])('daemon: the credential guard appends after caller entries for %s', (_label, request) => {
    const env = createDaemonPtyEnvironment({
      sessionId: 'wire',
      cols: 80,
      rows: 24,
      ...request
    })
    const entries = entriesOf(env)
    expect(entries.slice(0, PROFILE_ENTRIES.length)).toEqual(PROFILE_ENTRIES)
    expect(entries.length).toBeGreaterThan(PROFILE_ENTRIES.length)
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('renderer-side guard keeps caller entries and appends its own', () => {
    const env = protocolEnv(PROFILE_ENTRIES)
    expect(
      applyTerminalGitCredentialPromptGuard(env, {
        isUnattended: true,
        platform: 'linux'
      })
    ).toBe(true)
    const entries = entriesOf(env)
    expect(entries.slice(0, PROFILE_ENTRIES.length)).toEqual(PROFILE_ENTRIES)
    expect(entries.length).toBeGreaterThan(PROFILE_ENTRIES.length)
  })

  it('an invalid incoming protocol makes the guard append nothing (why the wrapper must refuse)', () => {
    const broken = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: 'c'
    }
    const env: Record<string, string> = { ...broken }
    applyTerminalGitCredentialPromptGuard(env, {
      isUnattended: true,
      platform: 'linux'
    })
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined()
  })

  it('SSH relay: an augmenter’s GIT_CONFIG set replaces the renderer’s wholesale (no profile guarantee over SSH)', () => {
    const merged = mergeGitConfigEnvProtocol(
      protocolEnv(PROFILE_ENTRIES),
      protocolEnv([['relay.key', 'v']])
    )
    expect(entriesOf(merged)).toEqual([['relay.key', 'v']])
  })
})
