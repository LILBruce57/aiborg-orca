// T21 (design §3.3 P/gitconfig). Real git, offline, temp HOME. Needs the Phase 2 implementation.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACME, acmeProfileJson, comparablePath } from './client-profile-test-fixtures'
import { gitLfsAvailable, gitOk, initRepo, runGit } from './client-profile-real-git-test-fixtures'
import { clientProfiles } from './client-profile-test-harness'
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

const SAFE_DIRS = ['/srv/shared/acme-mirror', 'C:/shared/checkout']

describe('T21 generated gitconfig', () => {
  let world: ClientProfileWorld
  let gitconfig: string

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: null })
    // The user's own global file, which the strict default must not include.
    writeFileSync(
      join(world.sandbox.home, '.gitconfig'),
      [
        '[user]',
        '\tname = Personal Name',
        '\temail = personal@fixture.invalid',
        '[safe]',
        ...SAFE_DIRS.map((dir) => `\tdirectory = ${dir}`),
        ''
      ].join('\n')
    )
    await clientProfiles.activate(ACME)
    gitconfig = join(world.profileHome(ACME), 'gitconfig')
  })

  afterEach(async () => world.dispose())

  // Only the trailing newline: a leading empty value (the `helper =` reset) is significant.
  const fileConfig = (...args: string[]) =>
    runGit(['config', '--file', gitconfig, ...args], {
      cwd: world.sandbox.root
    }).stdout.replace(/\r?\n$/, '')

  it('carries the LFS filter block', () => {
    expect(fileConfig('--get', 'filter.lfs.clean')).toBe('git-lfs clean -- %f')
    expect(fileConfig('--get', 'filter.lfs.smudge')).toBe('git-lfs smudge -- %f')
    expect(fileConfig('--get', 'filter.lfs.process')).toBe('git-lfs filter-process')
    expect(fileConfig('--bool', '--get', 'filter.lfs.required')).toBe('true')
  })

  it('copies the user’s safe.directory entries and includes nothing else of theirs', () => {
    expect(fileConfig('--get-all', 'safe.directory').split('\n')).toEqual(
      expect.arrayContaining(SAFE_DIRS)
    )
    expect(fileConfig('--get-all', 'include.path')).toBe('')
    expect(fileConfig('--get', 'user.email')).toBe('dev@acme.example')
  })

  it('resets the credential helper list before the gh helper and pins hooks and ssh', () => {
    expect(fileConfig('--get-all', 'credential.https://github.com.helper').split('\n')).toEqual([
      '',
      '!gh auth git-credential'
    ])
    expect(comparablePath(fileConfig('--get', 'core.hooksPath'))).toBe(
      comparablePath(join(world.profileHome(ACME), 'hooks'))
    )
    expect(fileConfig('--get', 'core.sshCommand')).toContain('IdentitiesOnly=yes')
    if (process.platform === 'win32') {
      expect(fileConfig('--bool', '--get', 'core.longpaths')).toBe('true')
    }
    expect(fileConfig('--get-all', 'url.aiborg-blocked://.pushInsteadOf')).toContain(
      'https://github.com/'
    )
  })

  it('hides the personal identity in an acme terminal and keeps LFS working there', async () => {
    const repo = initRepo(world.repos.acme.path)
    const env = await terminalChildEnv(world.worktreeIds.acme)
    expect(gitOk(['config', 'user.email'], { cwd: repo, env })).toBe('dev@acme.example')
    expect(gitOk(['config', 'filter.lfs.clean'], { cwd: repo, env })).toBe('git-lfs clean -- %f')
    writeFileSync(join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    expect(gitOk(['check-attr', 'filter', '--', 'asset.bin'], { cwd: repo, env })).toBe(
      'asset.bin: filter: lfs'
    )
    if (gitLfsAvailable()) {
      writeFileSync(join(repo, 'asset.bin'), Buffer.alloc(4096, 7))
      gitOk(['add', '.gitattributes', 'asset.bin'], { cwd: repo, env })
      expect(gitOk(['cat-file', '-p', ':asset.bin'], { cwd: repo, env })).toMatch(
        /^version https:\/\/git-lfs\.github\.com\/spec\/v1/
      )
    }
  })

  it('includes the user’s global file only when the profile opts in', async () => {
    world.sandbox.writeProfile(
      acmeProfileJson({
        git: {
          userName: 'Example Acme Dev',
          userEmail: 'dev@acme.example',
          sshPublicKey: 'ssh/id_ed25519.pub',
          includeGlobalGitconfig: true
        }
      })
    )
    await clientProfiles.init()
    await clientProfiles.activate(ACME)
    const include = fileConfig('--get-all', 'include.path')
    expect(
      include === '~/.gitconfig' ||
        comparablePath(include).includes(comparablePath(join(world.sandbox.home, '.gitconfig')))
    ).toBe(true)
  })
})
