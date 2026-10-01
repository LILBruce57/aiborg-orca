import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatClientProfileAuditLine } from '../audit/client-profile-audit'
import {
  initClientProfileRuntime,
  resetClientProfileRuntimeForTests,
  type ClientProfileRuntime
} from '../profiles/client-profile-runtime'
import { assertGitHubWriteAllowed } from './assert-github-write-allowed'
import { assertPushAllowed, setClientProfileGuardResolvers } from './assert-push-allowed'
import { parseRemoteOwner } from './client-profile-remote-owner'

let dir = ''
let rt: ClientProfileRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiborg-guard-'))
  mkdirSync(join(dir, 'clients'))
  writeFileSync(
    join(dir, 'clients', 'acme.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'acme',
      name: 'Acme',
      color: '#2F80ED',
      github: { allowedOrgs: ['acme-inc'] },
      git: { userName: 'Example Name', userEmail: 'dev@acme.example' }
    })
  )
  rt = initClientProfileRuntime({
    userDataPath: join(dir, 'userData'),
    env: { AIBORG_PROFILES_DIR: join(dir, 'clients'), AIBORG_PROFILES_ROOT: join(dir, 'profiles') },
    loadKeyringBackend: () => {
      throw new Error('unused')
    }
  })
})

afterEach(() => {
  setClientProfileGuardResolvers({ profileForWorktreePath: () => null })
  resetClientProfileRuntimeForTests()
  rmSync(dir, { recursive: true, force: true })
})

function audit(): string {
  return readFileSync(join(dir, 'profiles', 'acme', 'audit.jsonl'), 'utf8')
}

const gitReturning = (url: string) => vi.fn(async () => ({ stdout: `${url}\n` }))

describe('parseRemoteOwner', () => {
  it.each([
    ['https://github.com/Acme-Inc/r.git', 'github.com', 'acme-inc', false],
    ['git@github.com:acme-inc/r.git', 'github.com', 'acme-inc', false],
    ['ssh://git@ssh.github.com:443/acme-inc/r.git', 'github.com', 'acme-inc', false],
    ['aiborg-blocked://contoso-org/r.git', '', 'contoso-org', true],
    ['git@github.example.com:acme-inc/r.git', 'github.example.com', 'acme-inc', false]
  ])('%s', (url, host, owner, rewrittenToBlocked) => {
    expect(parseRemoteOwner(url)).toEqual({ host, owner, rewrittenToBlocked })
  })

  it('returns null for local paths', () => {
    expect(parseRemoteOwner('/srv/git/r.git')).toBeNull()
    expect(parseRemoteOwner('C:/srv/r.git')).toBeNull()
  })
})

describe('assertPushAllowed (H50-H52)', () => {
  it('allows everything in personal mode without running git', async () => {
    const runGit = gitReturning('https://github.com/contoso-org/r.git')
    await expect(assertPushAllowed('/wt', 'origin', runGit)).resolves.toBeUndefined()
    expect(runGit).not.toHaveBeenCalled()
  })

  it('checks the resolved push URL against the worktree profile', async () => {
    setClientProfileGuardResolvers({ profileForWorktreePath: () => rt.store.getProfile('acme') })
    const allowed = gitReturning('git@github.com:acme-inc/r.git')
    await assertPushAllowed('/wt', 'upstream', allowed)
    expect(allowed).toHaveBeenCalledWith(['remote', 'get-url', '--push', 'upstream'])
    await expect(
      assertPushAllowed('/wt', 'origin', gitReturning('https://github.com/contoso-org/r.git'))
    ).rejects.toThrow("AI-Borg: push to 'contoso-org' blocked: profile Acme only allows: acme-inc")
    await expect(
      assertPushAllowed('/wt', 'origin', gitReturning('aiborg-blocked://contoso-org/r.git'))
    ).rejects.toThrow(/blocked/)
    expect(audit()).toContain(
      '"event":"push.allowed","profileId":"acme","remote":"upstream","owner":"acme-inc","via":"app"'
    )
    expect(audit()).toContain('"event":"push.blocked"')
  })

  it('uses the active profile for unbound repos and fails closed on an unreadable URL', async () => {
    rt.sidecar.setActiveProfileId('acme')
    const failing = vi.fn(async () => {
      throw new Error('no such remote')
    })
    await expect(assertPushAllowed('/wt', 'origin', failing)).rejects.toThrow(/unknown remote/)
  })
})

describe('assertGitHubWriteAllowed (H54)', () => {
  it('refuses writes outside allowedOrgs before any request', () => {
    rt.sidecar.setActiveProfileId('acme')
    expect(() =>
      assertGitHubWriteAllowed({ owner: 'Acme-Inc', operation: 'pr.create' })
    ).not.toThrow()
    expect(() => assertGitHubWriteAllowed({ owner: 'contoso-org', operation: 'pr.merge' })).toThrow(
      "AI-Borg: pr.merge on 'contoso-org' blocked"
    )
    expect(audit()).toContain(
      '"event":"github.write.blocked","profileId":"acme","owner":"contoso-org","operation":"pr.merge"'
    )
  })

  it('allows everything in personal mode', () => {
    expect(() =>
      assertGitHubWriteAllowed({ owner: 'contoso-org', operation: 'issue.comment' })
    ).not.toThrow()
  })
})

describe('audit lines', () => {
  it('are single JSON lines and drop value-like fields', () => {
    const line = formatClientProfileAuditLine(
      'secret.set',
      'acme',
      { name: 'GH_TOKEN', value: 'fixture-secret-value' },
      new Date(0)
    )
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({
      ts: '1970-01-01T00:00:00.000Z',
      event: 'secret.set',
      profileId: 'acme',
      name: 'GH_TOKEN'
    })
  })
})
