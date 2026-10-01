import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateClientProfile } from '../../../shared/aiborg/client-profile-schema'
import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { buildClientProfileChildEnv } from '../env/apply-client-profile-env'
import { ensureClientProfileHome } from './client-profile-dirs'
import { toGitPath, type ClientProfileHomeLayout } from './client-profile-paths'

// Offline: every push here is refused before any network transport starts.
const profileResult = validateClientProfile({
  schemaVersion: 1,
  id: 'acme',
  name: 'Acme',
  color: '#2F80ED',
  github: { allowedOrgs: ['acme-inc'] },
  git: { userName: 'Example Name', userEmail: 'dev@acme.example' }
})
if (!profileResult.ok) {
  throw new Error(profileResult.errors.join('; '))
}
const acme: ClientProfile = profileResult.profile

let dir = ''
let layout: ClientProfileHomeLayout
let profileEnv: NodeJS.ProcessEnv

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = profileEnv, input = '') {
  const result = spawnSync('git', args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function auditLines(): Record<string, unknown>[] {
  if (!existsSync(layout.audit)) {
    return []
  }
  return readFileSync(layout.audit, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function newRepo(name: string, origin: string): string {
  const repo = join(dir, name)
  mkdirSync(repo)
  git(['init', '--quiet', '--initial-branch=main'], repo)
  git(['commit', '--quiet', '--allow-empty', '-m', 'init'], repo)
  git(['remote', 'add', 'origin', origin], repo)
  return repo
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aiborg-hooks-'))
  const home = join(dir, 'home')
  mkdirSync(home)
  writeFileSync(join(dir, 'empty-system-gitconfig'), '')
  layout = await ensureClientProfileHome(acme, {
    root: join(dir, 'profiles'),
    machine: { sshAuthSock: null, windowsSsh: null },
    env: {},
    home
  })
  // Why strip GIT_*: a test run from inside a git hook would otherwise leak GIT_DIR and friends.
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))
  )
  profileEnv = {
    ...buildClientProfileChildEnv(
      base,
      acme,
      { kind: 'local' },
      {
        root: join(dir, 'profiles'),
        machine: { sshAuthSock: null, windowsSsh: null },
        platform: process.platform,
        extraManagedKeys: [],
        readSecret: () => null,
        systemEnv: process.env
      }
    ),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_SYSTEM: join(dir, 'empty-system-gitconfig'),
    GIT_TERMINAL_PROMPT: '0'
  }
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('pushInsteadOf + git-remote-aiborg-blocked (layer 3)', () => {
  it.each([
    ['https', 'https://github.com/contoso-org/r.git'],
    ['scp-like ssh', 'git@github.com:contoso-org/r.git']
  ])('blocks a %s push to a disallowed org, with and without --no-verify', (_label, url) => {
    const repo = newRepo(`blocked-${_label.replace(/\W/g, '')}`, url)
    for (const extra of [[], ['--no-verify']]) {
      const result = git(['push', ...extra, 'origin', 'HEAD:main'], repo)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        "AI-Borg: push to 'contoso-org' blocked: profile Acme only allows: acme-inc"
      )
    }
    const rewrites = auditLines().filter(
      (line) => line.via === 'rewrite' && line.owner === 'contoso-org'
    )
    expect(rewrites.length).toBeGreaterThanOrEqual(2)
    expect(rewrites[0]).toMatchObject({ event: 'push.blocked', profileId: 'acme' })
  })

  it('leaves an allowed org pushable (identity rewrite wins by longest prefix)', () => {
    const repo = newRepo('allowed', 'https://github.com/acme-inc/r.git')
    expect(git(['remote', 'get-url', '--push', 'origin'], repo).stdout.trim()).toBe(
      'https://github.com/acme-inc/r.git'
    )
    const disallowed = newRepo('disallowed', 'https://github.com/acme-incx/r.git')
    expect(git(['remote', 'get-url', '--push', 'origin'], disallowed).stdout.trim()).toBe(
      'aiborg-blocked://acme-incx/r.git'
    )
  })
})

describe('pre-push hook (layer 2)', () => {
  it('blocks an explicit pushurl that pushInsteadOf does not rewrite', () => {
    const bare = join(dir, 'other.git')
    git(['init', '--quiet', '--bare', bare], dir)
    const repo = newRepo('pushurl', 'https://github.com/acme-inc/r.git')
    git(['config', 'remote.origin.pushurl', toGitPath(bare)], repo)
    const result = git(['push', 'origin', 'HEAD:main'], repo)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AI-Borg: push to ')
    expect(auditLines().some((line) => line.via === 'hook')).toBe(true)
  })

  it('passes an allowed owner on to the repo hook through the chain stub', () => {
    const repo = newRepo('chain', 'https://github.com/acme-inc/r.git')
    const marker = join(dir, 'repo-pre-push-ran')
    writeFileSync(
      join(repo, '.git', 'hooks', 'pre-push'),
      `#!/bin/sh\necho "$2" > '${toGitPath(marker)}'\n`,
      { mode: 0o755 }
    )
    // Why an alias: git runs `!` aliases with its own sh on every platform.
    const run = (url: string) =>
      git(
        [
          '-c',
          `alias.runhook=!sh '${toGitPath(join(layout.hooks, 'pre-push'))}'`,
          'runhook',
          'origin',
          url
        ],
        repo
      )
    const blocked = run('https://github.com/contoso-org/r.git')
    expect(blocked.status).toBe(1)
    expect(existsSync(marker)).toBe(false)
    expect(run('git@github.com:Acme-Inc/r.git').status).toBe(0)
    expect(readFileSync(marker, 'utf8').trim()).toBe('git@github.com:Acme-Inc/r.git')
  })
})

describe('hook chaining and command-scope identity', () => {
  it('runs a husky-style local hooksPath hook and commits as the profile identity', () => {
    const repo = newRepo('husky', 'https://github.com/acme-inc/r.git')
    mkdirSync(join(repo, '.husky'))
    const marker = join(dir, 'husky-ran')
    writeFileSync(join(repo, '.husky', 'pre-commit'), `#!/bin/sh\ntouch '${toGitPath(marker)}'\n`, {
      mode: 0o755
    })
    git(['config', 'core.hooksPath', '.husky'], repo)
    git(['config', 'user.email', 'personal@example.invalid'], repo)
    expect(git(['commit', '--quiet', '--allow-empty', '-m', 'second'], repo).status).toBe(0)
    expect(existsSync(marker)).toBe(true)
    expect(git(['log', '-1', '--format=%ae'], repo).stdout.trim()).toBe('dev@acme.example')
  })
})

describe('credential isolation (T5)', () => {
  it('never consults a system-scope credential helper', () => {
    const record = toGitPath(join(dir, 'system-helper-called'))
    const systemConfig = join(dir, 'recording-system-gitconfig')
    writeFileSync(
      systemConfig,
      `[credential]\n\thelper = "!f() { echo called >> '${record}'; }; f"\n`
    )
    const input = 'protocol=https\nhost=example.invalid\n\n'
    git(['credential', 'fill'], dir, { ...profileEnv, GIT_CONFIG_SYSTEM: systemConfig }, input)
    expect(existsSync(record)).toBe(false)
    // Control: without the profile's global file the fake helper does run.
    const { GIT_CONFIG_GLOBAL: _drop, ...personal } = profileEnv
    git(
      ['credential', 'fill'],
      dir,
      { ...personal, GIT_CONFIG_COUNT: '0', GIT_CONFIG_SYSTEM: systemConfig },
      input
    )
    expect(existsSync(record)).toBe(true)
  })
})
