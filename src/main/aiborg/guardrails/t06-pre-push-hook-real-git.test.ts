// T6 (design §5.1). Real git, offline: GitHub URLs are served from local bare repos by a fake ssh.
// Needs the Phase 3 implementation (generated P/hooks/pre-push).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACME, readJsonLines } from './client-profile-test-fixtures'
import {
  addRemotes,
  bareBranchHead,
  createBareRemote,
  fakeGitHubSshEnv,
  gitOk,
  initRepo,
  runGit,
  shPath
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

describe('T6 pre-push hook', () => {
  let world: ClientProfileWorld
  let repo: string
  let remotes: string
  let env: Record<string, string>
  let auditPath: string

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: ACME })
    remotes = join(world.sandbox.root, 'remotes')
    repo = initRepo(world.repos.acme.path)
    env = {
      ...(await terminalChildEnv(world.worktreeIds.acme)),
      ...fakeGitHubSshEnv(join(world.sandbox.root, 'fake-bin'), remotes)
    }
    auditPath = join(world.profileHome(ACME), 'audit.jsonl')
  })

  afterEach(async () => world.dispose())

  it('lets a push to an allowed org through', () => {
    const acmeBare = createBareRemote(remotes, 'acme-inc')
    addRemotes(repo, { origin: 'git@github.com:acme-inc/app.git' })
    gitOk(['push', 'origin', 'main'], { cwd: repo, env })
    expect(bareBranchHead(acmeBare)).toBe(gitOk(['rev-parse', 'HEAD'], { cwd: repo }))
  })

  it('blocks a disallowed explicit pushurl with the AI-Borg message and a hook audit line', () => {
    createBareRemote(remotes, 'acme-inc')
    const contosoBare = createBareRemote(remotes, 'contoso-org')
    addRemotes(repo, { origin: 'git@github.com:acme-inc/app.git' })
    // An explicit pushurl is not rewritten by pushInsteadOf, so only the hook can stop it.
    gitOk(['config', 'remote.origin.pushurl', 'git@github.com:contoso-org/app.git'], { cwd: repo })

    const result = runGit(['push', 'origin', 'main'], { cwd: repo, env })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("AI-Borg: push to 'contoso-org' blocked")
    expect(result.stderr).toContain('acme-inc')
    expect(bareBranchHead(contosoBare)).toBeNull()
    const blocked = readJsonLines(auditPath).filter((line) => line.event === 'push.blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]).toMatchObject({
      via: 'hook',
      owner: 'contoso-org',
      remote: 'origin',
      profileId: ACME
    })
    expect(Number.isNaN(Date.parse(String(blocked[0].ts)))).toBe(false)
  })

  it('fails closed on an SSH host alias it cannot attribute to an allowed org', () => {
    const contosoBare = createBareRemote(remotes, 'contoso-org')
    addRemotes(repo, { origin: 'git@github-contoso:contoso-org/app.git' })
    const result = runGit(['push', 'origin', 'main'], { cwd: repo, env })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AI-Borg')
    expect(bareBranchHead(contosoBare)).toBeNull()
  })

  it('attributes ssh.github.com:443 and userinfo URLs to their owner', () => {
    const hook = shPath(join(world.profileHome(ACME), 'hooks', 'pre-push'))
    // Why a git alias: it runs the hook through git's own sh on every platform.
    const runHook = (url: string) =>
      runGit(['-c', `alias.aiborg-pre-push=!sh "${hook}"`, 'aiborg-pre-push', 'origin', url], {
        cwd: repo,
        env,
        input: ''
      })
    expect(runHook('ssh://git@ssh.github.com:443/acme-inc/app.git').status).toBe(0)
    expect(runHook('https://x-access-token@github.com/acme-labs/app.git').status).toBe(0)
    const blocked = runHook('ssh://git@ssh.github.com:443/contoso-org/app.git')
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain("AI-Borg: push to 'contoso-org' blocked")
  })

  it('does not modify the client repo', () => {
    createBareRemote(remotes, 'acme-inc')
    addRemotes(repo, { origin: 'git@github.com:acme-inc/app.git' })
    gitOk(['push', 'origin', 'main'], { cwd: repo, env })
    expect(runGit(['config', '--local', '--get', 'core.hooksPath'], { cwd: repo }).status).not.toBe(
      0
    )
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-push'))).toBe(false)
  })
})
