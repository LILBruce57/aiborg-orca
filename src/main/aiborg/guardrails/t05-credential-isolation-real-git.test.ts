// T5 (design §3.3 "System config"). Real git, offline. Needs the Phase 2 implementation.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACME, comparablePath } from './client-profile-test-fixtures'
import {
  gitOk,
  initRepo,
  runGit,
  shPath,
  withPathPrefix,
  writeRecordingHelper
} from './client-profile-real-git-test-fixtures'
import { terminalChildEnv } from './client-profile-spawn-test-harness'
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

describe('T5 credential isolation', () => {
  let world: ClientProfileWorld
  let systemLog: string
  let ghLog: string
  let env: Record<string, string>

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: ACME })
    const bin = join(world.sandbox.root, 'fake-bin')
    systemLog = join(world.sandbox.root, 'system-helper.log')
    ghLog = join(world.sandbox.root, 'gh.log')
    // Stands in for Git for Windows' system `credential.helper=manager`.
    const systemHelper = writeRecordingHelper(bin, 'fake-system-helper', systemLog)
    // The profile helper is `!gh auth git-credential`; a recording gh keeps the real one out.
    writeRecordingHelper(bin, 'gh', ghLog)
    gitOk(
      [
        'config',
        '--file',
        world.sandbox.gitSystemConfig,
        'credential.helper',
        `!${shPath(systemHelper)}`
      ],
      {
        cwd: world.sandbox.root
      }
    )
    initRepo(world.repos.acme.path)
    env = withPathPrefix(await terminalChildEnv(world.worktreeIds.acme), bin)
  })

  afterEach(async () => world.dispose())

  const fill = (overrides: Record<string, string> = {}) =>
    runGit(['credential', 'fill'], {
      cwd: world.repos.acme.path,
      env: { ...env, ...overrides },
      input: 'protocol=https\nhost=github.com\n\n'
    })

  it('points GIT_CONFIG_GLOBAL at the generated profile gitconfig', () => {
    expect(comparablePath(env.GIT_CONFIG_GLOBAL)).toBe(
      comparablePath(join(world.profileHome(ACME), 'gitconfig'))
    )
    expect(existsSync(env.GIT_CONFIG_GLOBAL)).toBe(true)
  })

  it('never consults a system-scope credential helper, only the profile gh helper', () => {
    fill()
    expect(existsSync(systemLog)).toBe(false)
    expect(readFileSync(ghLog, 'utf8')).toContain('auth git-credential get')
  })

  it('control: the same env without the profile gitconfig does reach the system helper', () => {
    const emptyGlobal = join(world.sandbox.root, 'empty.gitconfig')
    gitOk(['config', '--file', emptyGlobal, 'core.fixture', 'true'], {
      cwd: world.sandbox.root
    })
    const withoutCommandScope = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) => !key.startsWith('GIT_CONFIG_') || key === 'GIT_CONFIG_SYSTEM'
      )
    )
    runGit(['credential', 'fill'], {
      cwd: world.repos.acme.path,
      env: { ...withoutCommandScope, GIT_CONFIG_GLOBAL: emptyGlobal },
      input: 'protocol=https\nhost=github.com\n\n'
    })
    expect(readFileSync(systemLog, 'utf8')).toContain('fake-system-helper get')
  })
})
