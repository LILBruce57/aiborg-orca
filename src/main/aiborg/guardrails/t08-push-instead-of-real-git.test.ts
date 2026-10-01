// T8 (design §5.2 layer 3). Real git, offline. Needs the Phase 3 implementation
// (pushInsteadOf block and the P/bin/git-remote-aiborg-blocked helper).
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
  runGit
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

describe('T8 pushInsteadOf and the blocked-remote helper', () => {
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
    addRemotes(repo, {
      contosoScp: 'git@github.com:contoso-org/app.git',
      contosoHttps: 'https://github.com/contoso-org/app.git',
      contosoSsh: 'ssh://git@github.com/contoso-org/app.git',
      acmeScp: 'git@github.com:acme-labs/app.git',
      acmeHttps: 'https://github.com/acme-inc/app.git'
    })
  })

  afterEach(async () => world.dispose())

  const pushUrl = (remote: string) =>
    gitOk(['remote', 'get-url', '--push', remote], { cwd: repo, env })

  it('rewrites every disallowed github.com form and keeps allowed orgs', () => {
    for (const remote of ['contosoScp', 'contosoHttps', 'contosoSsh']) {
      expect(pushUrl(remote)).toBe('aiborg-blocked://contoso-org/app.git')
    }
    expect(pushUrl('acmeScp')).toBe('git@github.com:acme-labs/app.git')
    expect(pushUrl('acmeHttps')).toBe('https://github.com/acme-inc/app.git')
  })

  it('rewrites userinfo, explicit-port and ssh.github.com spellings too (--no-verify layer)', () => {
    const variants = {
      tokenUser: 'https://x-access-token@github.com/contoso-org/app.git',
      gitUser: 'https://git@github.com/contoso-org/app.git',
      sshPort: 'ssh://git@github.com:22/contoso-org/app.git',
      sshAlias: 'git@ssh.github.com:contoso-org/app.git',
      ssh443: 'ssh://git@ssh.github.com:443/contoso-org/app.git'
    }
    addRemotes(repo, {
      ...variants,
      acmeToken: 'https://x-access-token@github.com/acme-inc/app.git',
      acme443: 'ssh://git@ssh.github.com:443/acme-labs/app.git'
    })
    for (const remote of Object.keys(variants)) {
      expect(pushUrl(remote)).toBe('aiborg-blocked://contoso-org/app.git')
    }
    expect(pushUrl('acmeToken')).toBe('https://x-access-token@github.com/acme-inc/app.git')
    expect(pushUrl('acme443')).toBe('ssh://git@ssh.github.com:443/acme-labs/app.git')
  })

  it.each([
    ['git push', ['push', 'contosoScp', 'main']],
    ['git push --no-verify', ['push', '--no-verify', 'contosoScp', 'main']],
    [
      'git push over https (offline: the helper runs before any network)',
      ['push', 'contosoHttps', 'main']
    ]
  ])(
    '%s to contoso-org fails with the AI-Borg message and a rewrite audit line',
    (_label, args) => {
      const contosoBare = createBareRemote(remotes, 'contoso-org')
      const result = runGit(args, { cwd: repo, env })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('AI-Borg')
      expect(result.stderr).toContain('contoso-org')
      expect(bareBranchHead(contosoBare)).toBeNull()
      const blocked = readJsonLines(auditPath).filter((line) => line.event === 'push.blocked')
      expect(blocked.at(-1)).toMatchObject({
        via: 'rewrite',
        owner: 'contoso-org',
        profileId: ACME
      })
    }
  )

  it('still pushes an allowed org, with and without --no-verify', () => {
    const labsBare = createBareRemote(remotes, 'acme-labs')
    gitOk(['push', 'acmeScp', 'main'], { cwd: repo, env })
    gitOk(['commit', '-q', '--allow-empty', '-m', 'second'], {
      cwd: repo,
      env
    })
    gitOk(['push', '--no-verify', 'acmeScp', 'main'], { cwd: repo, env })
    expect(bareBranchHead(labsBare)).toBe(gitOk(['rev-parse', 'HEAD'], { cwd: repo }))
  })
})
