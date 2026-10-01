// T22 central half (H54 in the gh runner): write paths with no guard of their own (stacked PRs,
// issue create/update, PR state, reruns, project mutations) are refused before gh runs.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ghExecFileWithScopeAsync } from '../../git/command-runner/gh-exec-file'
import { withClientProfileGhEnv } from '../binding/client-profile-process-env'
import { classifyGhWrite } from '../git/client-profile-gh-write-guard'
import { ACME, readJsonLines } from './client-profile-test-fixtures'
import { addRemotes, initRepo } from './client-profile-real-git-test-fixtures'
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

describe('gh write classification', () => {
  it.each([
    [['api', '-X', 'POST', 'repos/contoso-org/app/pulls', '-f', 'title=x'], 'contoso-org'],
    [['api', '--method=PATCH', '/repos/Contoso-Org/app/issues/3'], 'contoso-org'],
    [['api', 'repos/contoso-org/app/issues', '-f', 'title=x'], 'contoso-org'],
    [['issue', 'create', '--repo', 'contoso-org/app', '--title', 'x'], 'contoso-org'],
    [['pr', 'close', '5', '-R', 'github.example.com/contoso-org/app'], 'contoso-org'],
    [['pr', 'ready', '5'], null],
    [['api', 'graphql', '-f', 'query=mutation { addStar(input: {}) { clientMutationId } }'], null]
  ])('%j is a write on %s', (args, owner) => {
    expect(classifyGhWrite(args)).toMatchObject({ write: true, owner })
  })

  it.each([
    [['api', 'repos/contoso-org/app/pulls']],
    [['api', '-X', 'GET', 'repos/contoso-org/app/pulls', '-f', 'state=open']],
    [['api', 'graphql', '-f', 'query=query { viewer { login } }']],
    [['pr', 'view', '5', '--repo', 'contoso-org/app']],
    [['auth', 'status']]
  ])('%j is a read', (args) => {
    expect(classifyGhWrite(args)).toEqual({ write: false })
  })
})

describe('T22 central gh write guard', () => {
  let world: ClientProfileWorld
  let repo: string

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: ACME })
    repo = initRepo(world.repos.acme.path)
    addRemotes(repo, { origin: 'https://github.com/acme-inc/app.git' })
  })

  afterEach(async () => world.dispose())

  const blockedLines = () =>
    readJsonLines(join(world.profileHome(ACME), 'audit.jsonl')).filter(
      (line) => line.event === 'github.write.blocked'
    )

  it('refuses a stacked PR create (gh api POST) to contoso-org before gh runs', async () => {
    await expect(
      ghExecFileWithScopeAsync(['api', '-X', 'POST', 'repos/contoso-org/app/pulls'], {
        cwd: repo
      })
    ).rejects.toThrow(/AI-Borg: api\.post on 'contoso-org' blocked/)
    expect(blockedLines().at(-1)).toMatchObject({ owner: 'contoso-org', operation: 'api.post' })
  })

  it('refuses issue create, PR state changes and unattributable mutations', () => {
    const write = (args: string[], cwd?: string) => () =>
      withClientProfileGhEnv({}, cwd ? { cwd } : {}, args)
    expect(write(['issue', 'create', '--repo', 'contoso-org/app'], repo)).toThrow(/AI-Borg/)
    expect(write(['api', 'graphql', '-f', 'query=mutation { x }'])).toThrow(/unknown owner/)
    // No --repo: every remote of the cwd repo must be allowed (gh may pick any as the base).
    addRemotes(repo, { upstream: 'https://github.com/contoso-org/app.git' })
    expect(write(['pr', 'close', '5'], repo)).toThrow(/contoso-org/)
  })

  it('lets reads and writes to allowed orgs through, and personal mode untouched', async () => {
    const run = (args: string[]) => withClientProfileGhEnv({}, { cwd: repo }, args)
    expect(() => run(['api', '-X', 'POST', 'repos/acme-inc/app/pulls'])).not.toThrow()
    expect(() => run(['api', 'repos/contoso-org/app/pulls'])).not.toThrow()
    expect(() => run(['pr', 'close', '5'])).not.toThrow()
    await clientProfiles.activate(null)
    const unbound = initRepo(world.repos.unbound.path)
    addRemotes(unbound, { origin: 'https://github.com/example-oss/app.git' })
    const env = {}
    expect(
      withClientProfileGhEnv(env, { cwd: unbound }, ['api', '-X', 'POST', 'repos/x/y/pulls'])
    ).toBe(env)
  })
})
