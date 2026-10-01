// T16 main side (design §1.2 repo matching, §5.3). Real git, offline. Needs the Phase 2/3 implementation.
// The renderer half (dialog from all three activation entry points) is
// src/renderer/src/aiborg/guardrails/t16-worktree-activation-call-sites.test.ts.
// Defined here where the design is silent: org names match case-insensitively, like GitHub.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACME, CONTOSO, acmeProfileJson, contosoProfileJson } from './client-profile-test-fixtures'
import { addRemotes, gitOk, initRepo } from './client-profile-real-git-test-fixtures'
import { clientProfiles } from './client-profile-test-harness'
import { getClientProfileRuntime } from '../profiles/client-profile-runtime'
import { withClientProfileGitEnv } from '../binding/client-profile-process-env'
import { resolveCwdClientProfile } from '../binding/client-profile-resolution'
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

describe('T16 repo matching', () => {
  let world: ClientProfileWorld
  let counter = 0

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: ACME })
  })

  afterEach(async () => world.dispose())

  const repoWith = (remotes: Record<string, string>) => {
    counter += 1
    const path = initRepo(join(world.sandbox.root, 'work', `match-${counter}`))
    addRemotes(path, remotes)
    const repo = { id: `repo-match-${counter}`, path }
    clientProfiles.registerRepos([world.repos.acme, world.repos.contoso, world.repos.unbound, repo])
    return repo
  }

  it('attributes a repo by its origin push URL even when upstream points at another org', async () => {
    const acmeFork = repoWith({
      origin: 'git@github.com:acme-inc/oss-tool.git',
      upstream: 'https://github.com/contoso-org/oss-tool.git'
    })
    const contosoFork = repoWith({
      origin: 'https://github.com/contoso-org/app.git',
      upstream: 'git@github.com:acme-labs/app.git'
    })
    expect(await clientProfiles.profileForRepo(acmeFork)).toBe(ACME)
    expect(await clientProfiles.profileForRepo(contosoFork)).toBe(CONTOSO)
  })

  it('uses the push URL, not the fetch URL', async () => {
    const repo = repoWith({ origin: 'https://github.com/acme-inc/app.git' })
    gitOk(['config', 'remote.origin.pushurl', 'git@github.com:contoso-org/app.git'], {
      cwd: repo.path
    })
    expect(await clientProfiles.profileForRepo(repo)).toBe(CONTOSO)
  })

  it('matches org names case-insensitively', async () => {
    expect(
      await clientProfiles.profileForRepo(
        repoWith({ origin: 'https://github.com/Acme-Inc/app.git' })
      )
    ).toBe(ACME)
  })

  it('lets an explicit sidecar binding win, and leaves an unknown repo unbound', async () => {
    const noGitHub = repoWith({
      origin: 'https://git.example.invalid/team/app.git'
    })
    expect(await clientProfiles.profileForRepo(noGitHub)).toBeNull()
    await clientProfiles.bindRepo(noGitHub.id, CONTOSO)
    expect(await clientProfiles.profileForRepo(noGitHub)).toBe(CONTOSO)
    const stranger = repoWith({
      origin: 'https://github.com/example-oss/app.git'
    })
    expect(await clientProfiles.profileForRepo(stranger)).toBeNull()
  })

  it('matches a client remote under any name when origin names no client', async () => {
    const repo = repoWith({
      origin: 'https://github.com/example-oss/app.git',
      github: 'git@github.com:contoso-org/app.git'
    })
    expect(await clientProfiles.profileForRepo(repo)).toBe(CONTOSO)
    const noOrigin = repoWith({ company: 'https://github.com/acme-labs/app.git' })
    expect(await clientProfiles.profileForRepo(noOrigin)).toBe(ACME)
  })

  it('refuses instead of falling open when the matching profile file is broken', async () => {
    const repo = repoWith({ origin: 'https://github.com/acme-inc/app.git' })
    await clientProfiles.activate(null)
    const rt = getClientProfileRuntime()
    // A sync conflict or an edit typo: invalid, then unreadable JSON.
    world.sandbox.writeProfile(acmeProfileJson({ color: 'not-a-colour' }))
    rt?.store.reload()
    expect(resolveCwdClientProfile(repo.path)).toMatchObject({ profileId: ACME, profile: null })
    expect(() => withClientProfileGitEnv({}, { cwd: repo.path })).toThrow(/missing or invalid/)
    writeFileSync(join(world.sandbox.profilesDir, `${ACME}.json`), '{ "id": "acme", ')
    rt?.store.reload()
    expect(resolveCwdClientProfile(repo.path)).toMatchObject({ profileId: ACME, profile: null })
  })

  it('resolves a worktree created outside Orca (no worktree meta) by its git common dir', async () => {
    const repo = repoWith({ origin: 'https://github.com/acme-inc/app.git' })
    const outside = join(world.sandbox.root, 'orca', 'workspaces', 'app', 'feature')
    gitOk(['worktree', 'add', '-b', 'feature', outside], { cwd: repo.path })
    await clientProfiles.activate(null)
    expect(resolveCwdClientProfile(outside)).toMatchObject({
      profileId: ACME,
      repoId: repo.id
    })
  })

  it('rejects an org listed in two profiles', () => {
    const acme = clientProfiles.profileFrom(acmeProfileJson())
    const contoso = clientProfiles.profileFrom(
      contosoProfileJson({
        github: {
          host: 'github.com',
          allowedOrgs: ['contoso-org', 'acme-labs']
        }
      })
    )
    const errors = clientProfiles.validateProfileSet([acme, contoso])
    expect(errors.join('\n')).toContain('acme-labs')
    expect(
      clientProfiles.validateProfileSet([acme, clientProfiles.profileFrom(contosoProfileJson())])
    ).toEqual([])
  })
})
