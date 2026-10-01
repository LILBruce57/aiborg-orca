// Phase 4 overview: active profile's orgs only, its token only, 5-min cache, audit, error states.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecFileCapture from '../../git/command-runner/exec-file-capture'
import type { ClientProfileOverviewResult } from '../../../shared/aiborg/client-profile-overview-types'
import { getClientProfileRuntime } from '../profiles/client-profile-runtime'
import {
  ACME,
  acmeProfileJson,
  ALL_FIXTURE_SECRET_VALUES,
  AMBIENT_PERSONAL_ENV,
  CONTOSO,
  FIXTURE_SECRETS,
  readJsonLines
} from '../guardrails/client-profile-test-fixtures'
import { addRemotes, initRepo } from '../guardrails/client-profile-real-git-test-fixtures'
import { clientProfiles } from '../guardrails/client-profile-test-harness'
import {
  createClientProfileWorld,
  type ClientProfileWorld
} from '../guardrails/client-profile-world-test-harness'
import {
  CLIENT_PROFILE_OVERVIEW_TTL_MS,
  classifyClientProfileOverviewError,
  getClientProfileOverview,
  resetClientProfileOverviewForTests
} from './client-profile-overview'
import { OVERVIEW_MAX_REPOS } from './client-profile-overview-repos'

type Spawn = { args: readonly string[]; env: NodeJS.ProcessEnv }
type Reply = {
  stdout?: string
  stderr?: string
  error?: Record<string, unknown>
}

const { spawns, replies } = vi.hoisted(() => {
  const spawned: Spawn[] = []
  const queued: (Reply | (() => Promise<Reply>))[] = []
  return { spawns: spawned, replies: queued }
})

// The real H29 gh runner runs; only the gh process spawn is faked (git still runs for real).
vi.mock('../../git/command-runner/exec-file-capture', async (importOriginal) => {
  const actual = await importOriginal<typeof ExecFileCapture>()
  return {
    ...actual,
    execFileCaptureToTermination: async (
      ...call: Parameters<typeof actual.execFileCaptureToTermination>
    ) => {
      const [, args, options] = call
      if (!args.includes('graphql')) {
        return actual.execFileCaptureToTermination(...call)
      }
      spawns.push({ args, env: { ...options.env } })
      const next = replies.shift() ?? { stdout: '{"data":{}}' }
      const reply = typeof next === 'function' ? await next() : next
      if (reply.error) {
        throw Object.assign(new Error(reply.stderr ?? 'gh failed'), {
          stdout: reply.stdout ?? '',
          stderr: reply.stderr ?? '',
          ...reply.error
        })
      }
      return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
    }
  }
})
vi.mock(
  'electron',
  async () => (await import('../guardrails/client-profile-electron-test-fixture')).electronModule
)
vi.mock(
  '@napi-rs/keyring',
  async () => (await import('../guardrails/client-profile-keyring-test-fixture')).keyringModule
)

function pr(owner: string, repo: string, number: number, extra: Record<string, unknown> = {}) {
  return {
    __typename: 'PullRequest',
    number,
    title: `PR ${number}`,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    updatedAt: `2026-09-${String(10 + number).padStart(2, '0')}T10:00:00Z`,
    isDraft: false,
    author: { login: 'example-acme-login' },
    repository: { nameWithOwner: `${owner}/${repo}` },
    ...extra
  }
}

function search(nodes: unknown[]) {
  return { issueCount: nodes.length, nodes }
}

function repoNode(nameWithOwner: string) {
  return { nameWithOwner, url: `https://github.com/${nameWithOwner}`, refs: { nodes: [] } }
}

/** The world's two acme repos, in the order the overview asks for them. */
const KNOWN_REPOS = { repo0: repoNode('acme-inc/app'), repo1: repoNode('acme-labs/tools') }

/** Empty lists for up to three orgs (`o<i>_<list>`), overridden by `data`. */
function okReply(data: Record<string, unknown>, errors?: unknown[]): Reply {
  const empty = Object.fromEntries(
    [0, 1, 2].flatMap((index) =>
      ['authored', 'assigned', 'review', 'issues'].map((list) => [`o${index}_${list}`, search([])])
    )
  )
  return {
    stdout: JSON.stringify({
      data: { viewer: { login: 'example-acme-login' }, ...empty, ...KNOWN_REPOS, ...data },
      ...(errors ? { errors } : {})
    })
  }
}

function reloadProfiles(): void {
  getClientProfileRuntime()?.store.reload()
}

function queryOf(spawn: Spawn | undefined): string {
  const field = spawn?.args.find((arg) => arg.startsWith('query='))
  return field ?? ''
}

describe('client profile overview', () => {
  let world: ClientProfileWorld
  let now = Date.parse('2026-10-01T12:00:00Z')
  const clock = { now: () => now }
  const auditLines = (id = ACME) => {
    const path = join(world.profileHome(id), 'audit.jsonl')
    return existsSync(path)
      ? readJsonLines(path).filter((line) => line.event === 'github.overview.refresh')
      : []
  }

  beforeEach(async () => {
    spawns.length = 0
    replies.length = 0
    resetClientProfileOverviewForTests()
    world = await createClientProfileWorld({ active: ACME })
    initRepo(world.repos.acme.path)
    addRemotes(world.repos.acme.path, {
      origin: 'https://github.com/acme-inc/app.git'
    })
    initRepo(world.repos.contoso.path)
    addRemotes(world.repos.contoso.path, {
      origin: 'git@github.com:contoso-org/site.git'
    })
    // Unbound, claimed by acme through its origin org.
    initRepo(world.repos.unbound.path)
    addRemotes(world.repos.unbound.path, {
      origin: 'git@github.com:acme-labs/tools.git'
    })
  })

  afterEach(async () => {
    resetClientProfileOverviewForTests()
    await world.dispose()
  })

  it('queries only the active profile orgs and its known repos, with its token', async () => {
    const strayPath = join(world.sandbox.root, 'work', 'acme-bound-oss')
    mkdirSync(strayPath, { recursive: true })
    initRepo(strayPath)
    addRemotes(strayPath, { origin: 'https://github.com/example-oss/lib.git' })
    clientProfiles.registerRepos([
      world.repos.acme,
      world.repos.contoso,
      world.repos.unbound,
      { id: 'repo-stray', path: strayPath }
    ])
    await clientProfiles.bindRepo('repo-stray', ACME)
    replies.push(okReply({}))

    const result = await getClientProfileOverview({}, clock)

    expect(spawns).toHaveLength(1)
    const query = queryOf(spawns[0])
    expect(query).toContain('user:acme-inc sort:updated-desc')
    expect(query).toContain('user:acme-labs sort:updated-desc')
    expect(query).toContain('repository(owner: "acme-inc", name: "app")')
    expect(query).toContain('repository(owner: "acme-labs", name: "tools")')
    expect(query).not.toMatch(/contoso|example-oss/)
    expect(spawns[0].env.GH_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
    expect(spawns[0].env.GH_CONFIG_DIR).toBe(join(world.profileHome(ACME), 'gh'))
    expect(result).toMatchObject({ ok: true, profileId: ACME, repoCount: 2 })
  })

  it('groups results per allowed org and drops anything owned by another org', async () => {
    replies.push(
      okReply({
        o0_authored: search([pr('acme-inc', 'app', 1), pr('contoso-org', 'site', 2)]),
        o0_assigned: search([pr('acme-inc', 'app', 1)]),
        o0_review: search([pr('example-oss', 'lib', 4)]),
        o1_assigned: search([pr('acme-labs', 'tools', 3)]),
        o1_issues: search([
          {
            ...pr('acme-labs', 'tools', 5),
            __typename: 'Issue',
            url: 'https://github.com/acme-labs/tools/issues/5'
          }
        ]),
        repo0: {
          nameWithOwner: 'acme-inc/app',
          url: 'https://github.com/acme-inc/app',
          refs: {
            nodes: [
              {
                name: 'feature/login',
                target: { committedDate: '2026-09-30T09:00:00Z' }
              }
            ]
          }
        },
        repo1: {
          nameWithOwner: 'acme-labs/tools',
          url: 'https://github.com/acme-labs/tools',
          refs: { nodes: [] }
        }
      })
    )

    const result = await getClientProfileOverview({}, clock)
    if (!result.ok) {
      throw new Error(result.message)
    }
    expect(result.orgs.map((org) => org.org)).toEqual(['acme-inc', 'acme-labs'])
    const [inc, labs] = result.orgs
    expect(inc.pullRequests.map((item) => item.number)).toEqual([1])
    expect(inc.reviewRequests).toEqual([])
    expect(inc.branches).toEqual([
      expect.objectContaining({
        name: 'feature/login',
        url: 'https://github.com/acme-inc/app/tree/feature/login'
      })
    ])
    expect(labs.pullRequests.map((item) => item.number)).toEqual([3])
    expect(labs.issues).toEqual([expect.objectContaining({ kind: 'issue', number: 5 })])
    expect(JSON.stringify(result)).not.toMatch(/contoso|example-oss/)
    expect(result.orgs.every((org) => org.problem === null)).toBe(true)
  })

  it('drops links that are not https on the profile host before they reach the renderer', async () => {
    replies.push(
      okReply({
        o0_authored: search([
          pr('acme-inc', 'app', 1),
          pr('acme-inc', 'app', 2, {
            url: 'http://github.com/acme-inc/app/pull/2'
          }),
          pr('acme-inc', 'app', 3, {
            url: 'https://evil.example/acme-inc/app/pull/3'
          })
        ]),
        repo0: {
          nameWithOwner: 'acme-inc/app',
          url: 'https://evil.example/acme-inc/app',
          refs: { nodes: [{ name: 'main', target: null }] }
        }
      })
    )
    const result = await getClientProfileOverview({}, clock)
    if (!result.ok) {
      throw new Error(result.message)
    }
    expect(result.orgs[0].pullRequests.map((item) => item.number)).toEqual([1])
    expect(result.orgs[0].branches).toEqual([])
    expect(JSON.stringify(result)).not.toMatch(/evil\.example|http:\/\//)
  })

  it('a GitHub Enterprise profile queries its own host with its own token and links', async () => {
    world.sandbox.writeProfile(
      acmeProfileJson({
        github: {
          host: 'ghe.example.com',
          allowedOrgs: ['acme-inc'],
          login: 'example-acme-login'
        }
      })
    )
    reloadProfiles()
    replies.push(
      okReply({
        o0_review: search([
          pr('acme-inc', 'app', 1, {
            url: 'https://ghe.example.com/acme-inc/app/pull/1'
          }),
          pr('acme-inc', 'app', 2)
        ])
      })
    )
    const result = await getClientProfileOverview({}, clock)
    expect(spawns).toHaveLength(1)
    expect(spawns[0].args).toEqual(expect.arrayContaining(['--hostname', 'ghe.example.com']))
    expect(spawns[0].env.GH_ENTERPRISE_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
    // The local repos' origins are on github.com, so none of them belong to this host.
    expect(queryOf(spawns[0])).not.toContain('repository(')
    expect(result).toMatchObject({
      ok: true,
      host: 'ghe.example.com',
      repoCount: 0
    })
    expect(result.ok && result.orgs[0].reviewRequests.map((item) => item.url)).toEqual([
      'https://ghe.example.com/acme-inc/app/pull/1'
    ])
  })

  it('serves a 5-minute cache per profile; force and expiry refresh', async () => {
    replies.push(okReply({}), okReply({}), okReply({}))
    const first = await getClientProfileOverview({}, clock)
    now += 60_000
    const second = await getClientProfileOverview({}, clock)
    expect(spawns).toHaveLength(1)
    expect(second).toMatchObject({ ok: true, cached: true })
    expect(second.ok && first.ok && second.fetchedAt).toBe(first.ok && first.fetchedAt)

    await getClientProfileOverview({ force: true }, clock)
    expect(spawns).toHaveLength(2)
    now += CLIENT_PROFILE_OVERVIEW_TTL_MS + 1
    expect(await getClientProfileOverview({}, clock)).toMatchObject({
      cached: false
    })
    expect(spawns).toHaveLength(3)
  })

  it('coalesces concurrent refreshes into one gh call', async () => {
    replies.push(okReply({}))
    const [a, b] = await Promise.all([
      getClientProfileOverview({}, clock),
      getClientProfileOverview({}, clock)
    ])
    expect(spawns).toHaveLength(1)
    expect(a).toEqual(b)
  })

  it('a changed allowedOrgs list or a new known repo is not served from the cache', async () => {
    replies.push(okReply({}), okReply({}), okReply({}))
    await getClientProfileOverview({}, clock)
    world.sandbox.writeProfile(
      acmeProfileJson({
        github: {
          host: 'github.com',
          allowedOrgs: ['acme-inc'],
          login: 'example-acme-login'
        }
      })
    )
    reloadProfiles()
    await getClientProfileOverview({}, clock)
    expect(spawns).toHaveLength(2)
    expect(queryOf(spawns[1])).not.toContain('acme-labs')

    const extraPath = join(world.sandbox.root, 'work', 'acme-extra')
    mkdirSync(extraPath, { recursive: true })
    initRepo(extraPath)
    addRemotes(extraPath, { origin: 'https://github.com/acme-inc/extra.git' })
    clientProfiles.registerRepos([world.repos.acme, { id: 'repo-extra', path: extraPath }])
    const third = await getClientProfileOverview({}, clock)
    expect(spawns).toHaveLength(3)
    expect(queryOf(spawns[2])).toContain('repository(owner: "acme-inc", name: "extra")')
    expect(third).toMatchObject({ ok: true, cached: false })
  })

  it('a stored GH_TOKEN change drops the cached answer', async () => {
    replies.push(okReply({}), okReply({ viewer: { login: 'example-acme-other' } }))
    await getClientProfileOverview({}, clock)
    await clientProfiles.keychain.setSecret(ACME, 'GH_TOKEN', 'fixture-acme-gh-rotated')
    const result = await getClientProfileOverview({}, clock)
    expect(spawns).toHaveLength(2)
    expect(spawns[1].env.GH_TOKEN).toBe('fixture-acme-gh-rotated')
    expect(result).toMatchObject({
      ok: true,
      cached: false,
      viewerLogin: 'example-acme-other'
    })
  })

  it('caps the branch query and says so when more repos match', async () => {
    const repos = [world.repos.acme]
    for (let index = 0; index < OVERVIEW_MAX_REPOS; index++) {
      const path = join(world.sandbox.root, 'work', `acme-many-${index}`)
      mkdirSync(path, { recursive: true })
      initRepo(path)
      addRemotes(path, {
        origin: `https://github.com/acme-inc/many-${index}.git`
      })
      repos.push({ id: `repo-many-${index}`, path })
    }
    clientProfiles.registerRepos(repos)
    replies.push(okReply({}))
    const result = await getClientProfileOverview({}, clock)
    expect(queryOf(spawns[0]).match(/repository\(/g)).toHaveLength(OVERVIEW_MAX_REPOS)
    expect(result).toMatchObject({
      ok: true,
      repoCount: OVERVIEW_MAX_REPOS,
      reposTruncated: true
    })
  })

  it('keeps the cache per profile: a switch never serves another profile', async () => {
    replies.push(okReply({}), okReply({ viewer: { login: 'example-contoso-login' } }))
    await getClientProfileOverview({}, clock)
    await clientProfiles.activate(CONTOSO)
    const contoso = await getClientProfileOverview({}, clock)
    expect(spawns).toHaveLength(2)
    expect(spawns[1].env.GH_TOKEN).toBe(FIXTURE_SECRETS.contoso.GH_TOKEN)
    expect(queryOf(spawns[1])).toContain('user:contoso-org')
    expect(queryOf(spawns[1])).not.toContain('acme')
    expect(contoso).toMatchObject({
      ok: true,
      profileId: CONTOSO,
      cached: false
    })
  })

  it('never puts a token in the renderer payload', async () => {
    const leaked = FIXTURE_SECRETS.acme.GH_TOKEN
    replies.push(
      okReply({
        o0_authored: search([pr('acme-inc', 'app', 1, { token: leaked, body: leaked })]),
        extra: { token: leaked }
      })
    )
    const result = await getClientProfileOverview({}, clock)
    const payload = JSON.stringify(result)
    for (const value of [...ALL_FIXTURE_SECRET_VALUES, ...Object.values(AMBIENT_PERSONAL_ENV)]) {
      expect(payload).not.toContain(value)
    }
    const failure = classifyClientProfileOverviewError(ACME, {
      stderr: 'unexpected: ghp_abcdefghijklmnopqrstuvwxyz0123 rejected'
    })
    expect(failure.message).toContain('[redacted]')
    expect(failure.message).not.toContain('ghp_')
  })

  it('writes one audit line per real refresh, with the profile id and no cache-hit lines', async () => {
    replies.push(okReply({ o0_authored: search([pr('acme-inc', 'app', 1)]) }))
    await getClientProfileOverview({}, clock)
    await getClientProfileOverview({}, clock)
    const lines = auditLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      event: 'github.overview.refresh',
      profileId: ACME,
      host: 'github.com',
      orgs: 'acme-inc acme-labs',
      repos: 2,
      outcome: 'ok',
      items: 1
    })
    expect(auditLines(CONTOSO)).toHaveLength(0)
  })

  describe('error states', () => {
    it('not logged in: setup hint, audited, not cached', async () => {
      await clientProfiles.keychain.deleteSecret(ACME, 'GH_TOKEN')
      replies.push({
        error: { code: 4 },
        stderr: 'To get started with GitHub CLI, please run:  gh auth login'
      })
      const result = await getClientProfileOverview({}, clock)
      expect(result).toMatchObject({
        ok: false,
        profileId: ACME,
        reason: 'not-authenticated'
      })
      expect(!result.ok && result.message).toMatch(/gh auth login/)
      expect(auditLines().at(-1)).toMatchObject({
        outcome: 'not-authenticated'
      })
      replies.push(okReply({}))
      expect(await getClientProfileOverview({}, clock)).toMatchObject({
        ok: true
      })
    })

    it('a rejected stored GH_TOKEN is named, not sent to gh auth login', async () => {
      replies.push({
        error: { code: 1 },
        stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)'
      })
      const result = await getClientProfileOverview({}, clock)
      expect(result).toMatchObject({
        ok: false,
        profileId: ACME,
        reason: 'token-rejected'
      })
      expect(!result.ok && result.message).toMatch(/stored GH_TOKEN/)
      expect(auditLines().at(-1)).toMatchObject({ outcome: 'token-rejected' })
    })

    it('bad credentials count as not logged in', () => {
      expect(
        classifyClientProfileOverviewError(ACME, {
          stderr: 'HTTP 401: Bad credentials'
        })
      ).toMatchObject({ reason: 'not-authenticated' })
    })

    it('gh missing and rate limits are named', () => {
      const enoent = Object.assign(new Error('spawn gh ENOENT'), {
        code: 'ENOENT',
        syscall: 'spawn gh'
      })
      expect(classifyClientProfileOverviewError(ACME, enoent)).toMatchObject({
        reason: 'gh-missing'
      })
      expect(
        classifyClientProfileOverviewError(ACME, {
          stderr: 'API rate limit exceeded for user'
        })
      ).toMatchObject({ reason: 'rate-limited' })
    })

    it('a GraphQL partial error still returns the data, with the problem on its org', async () => {
      const message = "Could not resolve to a Repository with the name 'acme-inc/app'."
      replies.push({
        ...okReply({ repo0: null, o0_authored: search([pr('acme-inc', 'app', 1)]) }, [
          { type: 'NOT_FOUND', path: ['repo0'], message }
        ]),
        error: { code: 1 },
        stderr: `GraphQL: ${message}`
      })
      const result = await getClientProfileOverview({}, clock)
      expect(result).toMatchObject({ ok: true, problem: null })
      if (!result.ok) {
        return
      }
      expect(result.orgs[0]).toMatchObject({
        problem: { kind: 'not-found', message }
      })
      expect(result.orgs[0].pullRequests).toHaveLength(1)
      expect(result.orgs[1].problem).toBeNull()
    })

    it('SSO enforcement on one org is named for that org; the other org still loads', async () => {
      const message =
        'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.'
      replies.push({
        ...okReply(
          {
            o0_authored: search([pr('acme-inc', 'app', 1)]),
            o1_authored: null,
            o1_assigned: null,
            o1_review: null,
            o1_issues: null
          },
          ['o1_authored', 'o1_assigned', 'o1_review', 'o1_issues'].map((alias) => ({
            type: 'FORBIDDEN',
            path: [alias],
            message
          }))
        ),
        error: { code: 1 },
        stderr: `GraphQL: ${message}`
      })
      const result = await getClientProfileOverview({}, clock)
      if (!result.ok) {
        throw new Error(result.message)
      }
      const [inc, labs] = result.orgs
      expect(inc).toMatchObject({ problem: null })
      expect(inc.pullRequests).toHaveLength(1)
      // De-duplicated: four identical errors become one message.
      expect(labs.problem).toEqual({ kind: 'sso', message })
    })

    it('a list GitHub left out is an error for that org, not "nothing open"', async () => {
      replies.push(okReply({ o1_review: null }))
      const result = await getClientProfileOverview({}, clock)
      expect(result.ok && result.orgs[1].problem).toEqual({
        kind: 'failed',
        message: ''
      })
      expect(result.ok && result.orgs[0].problem).toBeNull()
    })

    it('a rate-limited forced refresh keeps the last good answer and names the limit', async () => {
      const responses: (() => Promise<{ stdout: string; stderr: string }>)[] = [
        async () => ({ stdout: okReply({}).stdout ?? '', stderr: '' }),
        async () => {
          throw Object.assign(new Error('rate limited'), {
            stdout: '',
            stderr: 'GitHub API rate limit is exhausted; retrying in ~42s'
          })
        }
      ]
      const runGh = async (): Promise<{ stdout: string; stderr: string }> => {
        const next = responses.shift()
        if (!next) {
          throw new Error('unexpected gh call')
        }
        return next()
      }
      const first = await getClientProfileOverview({}, { ...clock, runGh })
      const second = await getClientProfileOverview({ force: true }, { ...clock, runGh })
      expect(second).toMatchObject({ ok: true, cached: true })
      expect(second.ok && second.fetchedAt).toBe(first.ok && first.fetchedAt)
      expect(second.ok && second.rateLimitMessage).toMatch(/retrying in ~42s/)
      expect(auditLines().at(-1)).toMatchObject({
        outcome: 'rate-limited',
        items: 0
      })
    })

    it('personal mode: no gh call and no audit', async () => {
      await clientProfiles.activate(null)
      const result: ClientProfileOverviewResult = await getClientProfileOverview({}, clock)
      expect(result).toMatchObject({
        ok: false,
        profileId: null,
        reason: 'no-active-profile'
      })
      expect(spawns).toHaveLength(0)
      expect(auditLines(ACME)).toHaveLength(0)
      expect(auditLines(CONTOSO)).toHaveLength(0)
    })

    it('a switch mid-refresh discards the answer instead of caching it', async () => {
      replies.push(async () => {
        await clientProfiles.activate(CONTOSO)
        return okReply({})
      })
      const result = await getClientProfileOverview({}, clock)
      expect(result).toMatchObject({
        ok: false,
        profileId: ACME,
        reason: 'profile-changed'
      })
      expect(auditLines().at(-1)).toMatchObject({
        outcome: 'profile-changed',
        items: 0
      })
      await clientProfiles.activate(ACME)
      replies.push(okReply({}))
      expect(await getClientProfileOverview({}, clock)).toMatchObject({
        ok: true,
        cached: false
      })
    })

    // Why: a gh retry re-resolves the *active* profile's env, so a retry after a switch would
    // run acme's query with contoso's (or the personal) token.
    it.each([
      ['contoso', CONTOSO],
      ['personal', null]
    ])(
      'a transient error plus a switch to %s never re-runs the query with another token',
      async (_label, next) => {
        replies.push(async () => {
          await clientProfiles.activate(next)
          return {
            error: { code: 1 },
            stderr: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)'
          }
        })
        replies.push(okReply({ viewer: { login: 'example-contoso-login' } }))
        const result = await getClientProfileOverview({}, clock)
        expect(result).toMatchObject({ ok: false, profileId: ACME })
        expect(spawns).toHaveLength(1)
        for (const spawn of spawns) {
          expect(spawn.env.GH_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
        }
        // Nothing was cached for acme: back on acme, the next call asks gh again.
        await clientProfiles.activate(ACME)
        replies.length = 0
        replies.push(okReply({}))
        expect(await getClientProfileOverview({}, clock)).toMatchObject({
          ok: true,
          cached: false
        })
        expect(spawns).toHaveLength(2)
        expect(spawns[1].env.GH_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
      }
    )
  })
})
