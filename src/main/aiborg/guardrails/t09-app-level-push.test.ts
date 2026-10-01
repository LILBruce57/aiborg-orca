// T9 (design §5.2 layer 1: H50 gitPush, H51 fork sync, H52 SSH push). Real git for remote
// resolution; network commands (push, fetch, ls-remote) are intercepted so nothing leaves the
// machine. Needs the Phase 3 implementation.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../../git/runner'
import { gitSyncForkDefaultBranch } from '../../git/fork-sync'
import { gitPush } from '../../git/remote'
import { assertClientProfileSshPush } from '../binding/client-profile-push-guards'
import { clientProfiles } from './client-profile-test-harness'
import { ACME, readJsonLines } from './client-profile-test-fixtures'
import { addRemotes, commitAs, gitOk, initRepo } from './client-profile-real-git-test-fixtures'
import {
  createClientProfileWorld,
  type ClientProfileWorld
} from './client-profile-world-test-harness'

const { networkCalls } = vi.hoisted(() => {
  const calls: string[][] = []
  return { networkCalls: calls }
})

vi.mock(
  'electron',
  async () => (await import('./client-profile-electron-test-fixture')).electronModule
)
vi.mock(
  '@napi-rs/keyring',
  async () => (await import('./client-profile-keyring-test-fixture')).keyringModule
)
vi.mock('../../git/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return {
    ...actual,
    gitExecFileAsync: vi.fn(
      async (args: string[], options: Parameters<typeof actual.gitExecFileAsync>[1]) => {
        if (['push', 'fetch', 'ls-remote'].includes(args[0])) {
          networkCalls.push(args)
          if (args[0] === 'ls-remote') {
            throw new Error('offline')
          }
          return { stdout: '', stderr: '' }
        }
        return actual.gitExecFileAsync(args, options)
      }
    )
  }
})

const pushes = () => networkCalls.filter((args) => args[0] === 'push')

describe('T9 app-level push guard', () => {
  let world: ClientProfileWorld
  let repo: string
  let auditPath: string

  beforeEach(async () => {
    networkCalls.length = 0
    world = await createClientProfileWorld({ active: ACME })
    repo = initRepo(world.repos.acme.path)
    auditPath = join(world.profileHome(ACME), 'audit.jsonl')
  })

  afterEach(async () => world.dispose())

  const expectBlockedBeforeExec = async (push: Promise<unknown>) => {
    await expect(push).rejects.toThrow(/AI-Borg/)
    expect(pushes()).toEqual([])
    const blocked = readJsonLines(auditPath).filter((line) => line.event === 'push.blocked')
    expect(blocked.at(-1)).toMatchObject({
      via: 'app',
      owner: 'contoso-org',
      profileId: ACME
    })
  }

  it('rejects an explicit disallowed target', async () => {
    addRemotes(repo, {
      origin: 'https://github.com/acme-inc/app.git',
      contoso: 'https://github.com/contoso-org/app.git'
    })
    await expectBlockedBeforeExec(
      gitPush(repo, false, {
        remoteName: 'contoso',
        branchName: 'main',
        remoteUrl: 'https://github.com/contoso-org/app.git'
      })
    )
  })

  it('rejects a configured upstream on a disallowed org', async () => {
    addRemotes(repo, {
      origin: 'https://github.com/acme-inc/app.git',
      contoso: 'git@github.com:contoso-org/app.git'
    })
    gitOk(['update-ref', 'refs/remotes/contoso/main', 'HEAD'], { cwd: repo })
    gitOk(['config', 'branch.main.remote', 'contoso'], { cwd: repo })
    gitOk(['config', 'branch.main.merge', 'refs/heads/main'], { cwd: repo })
    await expectBlockedBeforeExec(gitPush(repo))
  })

  it('rejects the origin HEAD fallback on a disallowed org', async () => {
    addRemotes(repo, { origin: 'https://github.com/contoso-org/app.git' })
    await expectBlockedBeforeExec(gitPush(repo))
  })

  it('judges the push URL, not the fetch URL', async () => {
    addRemotes(repo, { origin: 'https://github.com/acme-inc/app.git' })
    gitOk(['config', 'remote.origin.pushurl', 'https://github.com/contoso-org/app.git'], {
      cwd: repo
    })
    await expectBlockedBeforeExec(gitPush(repo))
  })

  it('lets an allowed org reach the push exec and audits it', async () => {
    addRemotes(repo, { origin: 'git@github.com:acme-labs/app.git' })
    await gitPush(repo)
    expect(pushes()).toEqual([['push', '--set-upstream', 'origin', 'HEAD']])
    expect(readJsonLines(auditPath).some((line) => line.event === 'push.allowed')).toBe(true)
  })

  describe('fork sync (H51)', () => {
    const prepareFork = (originUrl: string) => {
      addRemotes(repo, {
        origin: originUrl,
        upstream: 'https://github.com/example-oss/app.git'
      })
      gitOk(['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repo })
      commitAs(repo, 'upstream moved on')
      gitOk(['update-ref', 'refs/remotes/upstream/main', 'HEAD'], {
        cwd: repo
      })
    }

    it('rejects syncing into a disallowed origin before pushing', async () => {
      prepareFork('https://github.com/contoso-org/app.git')
      await expect(
        gitSyncForkDefaultBranch(repo, { owner: 'example-oss', repo: 'app' })
      ).rejects.toThrow(/AI-Borg/)
      expect(pushes()).toEqual([])
    })

    it('syncs an allowed origin', async () => {
      prepareFork('https://github.com/acme-inc/app.git')
      const result = await gitSyncForkDefaultBranch(repo, {
        owner: 'example-oss',
        repo: 'app'
      })
      expect(result.status).toBe('synced')
      expect(pushes()).toHaveLength(1)
    })
  })

  describe('SSH provider push (H52)', () => {
    // A fake SSH provider: `exec` answers from a table, as git on the remote host would.
    const sshProvider = (remotes: Record<string, string>) => {
      const calls: string[][] = []
      return {
        calls,
        exec: async (args: string[]) => {
          calls.push(args)
          if (args[0] === 'remote' && args[1] === 'get-url') {
            const name = args.at(-1) ?? ''
            const url = remotes[name]
            if (!url) {
              throw new Error(`fatal: No such remote '${name}'`)
            }
            return { stdout: `${url}\n`, stderr: '' }
          }
          throw new Error(`git ${args.join(' ')}: not configured`)
        }
      }
    }
    const remotePath = '/home/dev/acme-app'

    beforeEach(() => {
      clientProfiles.registerRepos([
        world.repos.acme,
        { id: 'repo-ssh', path: remotePath, connectionId: 'ssh-1' }
      ])
    })

    it('rejects a disallowed target before provider.pushBranch is sent', async () => {
      const provider = sshProvider({ contoso: 'git@github.com:contoso-org/app.git' })
      await expect(
        assertClientProfileSshPush(provider, remotePath, {
          remoteName: 'contoso',
          branchName: 'main',
          remoteUrl: 'git@github.com:contoso-org/app.git'
        })
      ).rejects.toThrow(/AI-Borg: push to 'contoso-org' blocked/)
    })

    it('allows an allowed org and falls back to origin without a target', async () => {
      const provider = sshProvider({ origin: 'git@github.com:acme-inc/app.git' })
      await expect(assertClientProfileSshPush(provider, remotePath, undefined)).resolves.toBe(
        undefined
      )
    })

    it('makes no remote round trip in personal mode', async () => {
      await clientProfiles.activate(null)
      const provider = sshProvider({ origin: 'git@github.com:contoso-org/app.git' })
      await assertClientProfileSshPush(provider, remotePath, undefined)
      expect(provider.calls).toEqual([])
    })
  })
})
