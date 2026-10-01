// T22 (design §5.2 "GitHub API writes", H54). `gh` is intercepted; git reads use real temp repos.
// Needs the Phase 3 implementation. A refusal may throw or return { ok: false }; either way it names
// AI-Borg and no gh request is made.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../../git/runner'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { addPRReviewComment } from '../../github/client/create/add-pr-review-comment'
import { createGitHubPullRequest } from '../../github/client/create/create-github-pull-request'
import { mergePR } from '../../github/client/merge/merge-pr'
import { mergeGitHubPRStack } from '../../github/github-pr-stack-async-merge'
import { addIssueComment } from '../../github/issue-comment'
import { ACME, isRecord, readJsonLines } from './client-profile-test-fixtures'
import { addRemotes, initRepo } from './client-profile-real-git-test-fixtures'
import {
  createClientProfileWorld,
  type ClientProfileWorld
} from './client-profile-world-test-harness'

const { ghCalls } = vi.hoisted(() => {
  const calls: string[][] = []
  return { ghCalls: calls }
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
    ghExecFileAsync: vi.fn(async (args: string[]) => {
      ghCalls.push(args)
      throw new Error('gh is offline in this test')
    })
  }
})

const CONTOSO_REPO = { owner: 'contoso-org', repo: 'app' }
const ACME_REPO = { owner: 'acme-inc', repo: 'app' }

async function expectRefused(run: () => Promise<unknown>): Promise<void> {
  let outcome: unknown
  let thrown: unknown
  try {
    outcome = await run()
  } catch (error) {
    thrown = error
  }
  const message =
    thrown instanceof Error
      ? thrown.message
      : isRecord(outcome) && outcome.ok === false
        ? String(outcome.error)
        : `not refused: ${JSON.stringify(outcome)}`
  expect(message).toMatch(/AI-Borg/)
  expect(ghCalls).toEqual([])
}

describe('T22 GitHub API writes', () => {
  let world: ClientProfileWorld
  let repo: string

  beforeEach(async () => {
    ghCalls.length = 0
    world = await createClientProfileWorld({ active: ACME })
    repo = initRepo(world.repos.acme.path)
    addRemotes(repo, { origin: 'https://github.com/contoso-org/app.git' })
  })

  afterEach(async () => world.dispose())

  it('refuses PR create for a contoso-org repo under acme', async () => {
    await expectRefused(() =>
      createGitHubPullRequest(
        repo,
        {
          provider: 'github',
          base: 'main',
          head: 'feature',
          title: 'Fixture PR'
        },
        LOCAL_EXECUTION_HOST_ID
      )
    )
  })

  it('refuses issue and review comments', async () => {
    await expectRefused(() => addIssueComment(repo, 1, 'fixture comment', null, CONTOSO_REPO))
    await expectRefused(() =>
      addPRReviewComment({
        repoPath: repo,
        prRepo: CONTOSO_REPO,
        prNumber: 1,
        commitId: '0'.repeat(40),
        path: 'README.md',
        line: 1,
        body: 'fixture review comment'
      })
    )
  })

  it('refuses merges, including the async stack merge', async () => {
    await expectRefused(() => mergePR(repo, 1, 'squash', null, CONTOSO_REPO))
    await expectRefused(() =>
      mergeGitHubPRStack({
        repository: CONTOSO_REPO,
        prNumber: 1,
        method: 'squash',
        mergeAction: 'direct_merge',
        ghOptions: { cwd: repo }
      })
    )
  })

  it('audits each refusal with owner and operation', async () => {
    await addIssueComment(repo, 1, 'fixture comment', null, CONTOSO_REPO).catch(() => null)
    const blocked = readJsonLines(join(world.profileHome(ACME), 'audit.jsonl')).filter(
      (line) => line.event === 'github.write.blocked'
    )
    expect(blocked.at(-1)).toMatchObject({
      owner: 'contoso-org',
      profileId: ACME
    })
    expect(typeof blocked.at(-1)?.operation).toBe('string')
  })

  it('still sends writes for an allowed org', async () => {
    await addIssueComment(repo, 1, 'fixture comment', null, ACME_REPO).catch(() => null)
    expect(ghCalls.length).toBeGreaterThan(0)
  })
})
