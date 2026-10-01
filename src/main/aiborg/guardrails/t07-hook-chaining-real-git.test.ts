// T7 (design §3.3 P/hooks, §5.1). Real git, offline. Needs the Phase 3 implementation (chain stubs).
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACME } from './client-profile-test-fixtures'
import {
  addRemotes,
  createBareRemote,
  fakeGitHubSshEnv,
  gitOk,
  initRepo,
  runGit,
  shPath,
  writeExecutable
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

describe('T7 hook chaining', () => {
  let world: ClientProfileWorld
  let repo: string
  let remotes: string
  let marker: string
  let env: Record<string, string>

  const recordingHook = (name: string, exitCode = 0): string =>
    [
      '#!/bin/sh',
      `echo "${name} $*" >> "${shPath(marker)}"`,
      name === 'pre-push' ? `cat >> "${shPath(marker)}"` : ':',
      `exit ${exitCode}`,
      ''
    ].join('\n')

  const commit = (cwd: string, message: string) =>
    gitOk(['commit', '-q', '--allow-empty', '-m', message], { cwd, env })

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: ACME })
    remotes = join(world.sandbox.root, 'remotes')
    marker = join(world.sandbox.root, 'repo-hooks.log')
    repo = initRepo(world.repos.acme.path)
    createBareRemote(remotes, 'acme-inc')
    createBareRemote(remotes, 'contoso-org')
    addRemotes(repo, { origin: 'git@github.com:acme-inc/app.git' })
    env = {
      ...(await terminalChildEnv(world.worktreeIds.acme)),
      ...fakeGitHubSshEnv(join(world.sandbox.root, 'fake-bin'), remotes)
    }
  })

  afterEach(async () => world.dispose())

  const useHusky = () => {
    mkdirSync(join(repo, '.husky'))
    gitOk(['config', 'core.hooksPath', '.husky'], { cwd: repo })
    return join(repo, '.husky')
  }

  it('still runs a husky-style pre-push after ours, with the refs on stdin', () => {
    writeExecutable(join(useHusky(), 'pre-push'), recordingHook('pre-push'))
    gitOk(['push', 'origin', 'main'], { cwd: repo, env })
    const log = readFileSync(marker, 'utf8')
    expect(log).toContain('pre-push origin git@github.com:acme-inc/app.git')
    expect(log).toContain('refs/heads/main')
  })

  it('runs our guard first: a blocked push never reaches the repo hook (command-scope hooksPath wins)', () => {
    writeExecutable(join(useHusky(), 'pre-push'), recordingHook('pre-push'))
    gitOk(['config', 'remote.origin.pushurl', 'git@github.com:contoso-org/app.git'], { cwd: repo })
    const result = runGit(['push', 'origin', 'main'], { cwd: repo, env })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AI-Borg')
    expect(existsSync(marker)).toBe(false)
  })

  it('chains to .git/hooks when the repo has no hooksPath of its own', () => {
    writeExecutable(join(repo, '.git', 'hooks', 'pre-push'), recordingHook('pre-push'))
    gitOk(['push', 'origin', 'main'], { cwd: repo, env })
    expect(readFileSync(marker, 'utf8')).toContain('pre-push origin')
  })

  it('propagates a failing repo hook', () => {
    writeExecutable(join(repo, '.git', 'hooks', 'pre-push'), recordingHook('pre-push', 1))
    expect(runGit(['push', 'origin', 'main'], { cwd: repo, env }).status).not.toBe(0)
  })

  it('passes other client hooks through (pre-commit, commit-msg)', () => {
    writeExecutable(join(repo, '.git', 'hooks', 'pre-commit'), recordingHook('pre-commit'))
    commit(repo, 'plain hooks')
    expect(readFileSync(marker, 'utf8')).toContain('pre-commit')
    writeExecutable(join(useHusky(), 'commit-msg'), recordingHook('commit-msg'))
    commit(repo, 'husky hooks')
    expect(readFileSync(marker, 'utf8')).toMatch(/commit-msg .*COMMIT_EDITMSG/)
  })

  it('finds the common hooks directory from a linked worktree', () => {
    writeExecutable(join(repo, '.git', 'hooks', 'pre-commit'), recordingHook('pre-commit'))
    const linked = join(world.sandbox.root, 'work', 'acme-app-feature')
    gitOk(['worktree', 'add', '-q', '-b', 'feature', linked], { cwd: repo })
    commit(linked, 'from linked worktree')
    expect(readFileSync(marker, 'utf8')).toContain('pre-commit')
  })
})
