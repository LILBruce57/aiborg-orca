// Runs today, without the implementation: proves the git behaviour design §3.3/§5 relies on,
// on the git binary of this machine (offline, temp repos, temp HOME and system config).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { definedEnv } from './client-profile-test-fixtures'
import {
  createClientProfileSandbox,
  type ClientProfileSandbox
} from './client-profile-sandbox-test-fixture'
import {
  addRemotes,
  bareBranchHead,
  createBareRemote,
  fakeGitHubSshEnv,
  gitOk,
  initRepo,
  runGit,
  shPath,
  withPathPrefix,
  writeExecutable,
  writeRecordingHelper
} from './client-profile-real-git-test-fixtures'

const BLOCKED_HELPER = [
  '#!/bin/sh',
  'echo "AI-Borg: push blocked ($2)" >&2',
  'echo blocked >> "$AIBORG_TEST_LOG"',
  'exit 1',
  ''
].join('\n')

function commandScope(entries: readonly (readonly [string, string])[]): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length)
  }
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

function pushRewrites(allowedOrgs: readonly string[]): [string, string][] {
  const prefixes = ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/']
  return [
    ...prefixes.map((prefix): [string, string] => ['url.aiborg-blocked://.pushInsteadOf', prefix]),
    ...allowedOrgs.flatMap((org) =>
      prefixes.map((prefix): [string, string] => [
        `url.${prefix}${org}/.pushInsteadOf`,
        `${prefix}${org}/`
      ])
    )
  ]
}

describe('git mechanisms behind the client-profile guardrails (contract)', () => {
  let sandbox: ClientProfileSandbox
  let bin: string
  let remotes: string
  let log: string
  let repo: string
  let baseEnv: Record<string, string>

  beforeEach(() => {
    sandbox = createClientProfileSandbox({ profiles: false, ambient: false })
    bin = join(sandbox.root, 'bin')
    remotes = join(sandbox.root, 'remotes')
    log = join(sandbox.root, 'events.log')
    mkdirSync(bin, { recursive: true })
    writeExecutable(join(bin, 'git-remote-aiborg-blocked'), BLOCKED_HELPER)
    const global = join(sandbox.root, 'empty-global.gitconfig')
    writeFileSync(global, '')
    baseEnv = withPathPrefix(
      {
        ...definedEnv(process.env),
        ...fakeGitHubSshEnv(bin, remotes),
        GIT_CONFIG_GLOBAL: global,
        AIBORG_TEST_LOG: shPath(log)
      },
      bin
    )
    repo = initRepo(join(sandbox.root, 'work', 'app'), baseEnv)
  })

  afterEach(() => sandbox.dispose())

  it('keeps allowed orgs pushable and rewrites every other github.com push URL (longest prefix wins)', () => {
    addRemotes(repo, {
      allowedScp: 'git@github.com:acme-inc/app.git',
      allowedHttps: 'https://github.com/acme-labs/app.git',
      otherScp: 'git@github.com:contoso-org/app.git',
      otherHttps: 'https://github.com/contoso-org/app.git',
      otherSsh: 'ssh://git@github.com/contoso-org/app.git',
      // A prefix-sharing org must not ride on an allowed org's rule.
      lookalike: 'https://github.com/acme-inc-evil/app.git'
    })
    const env = {
      ...baseEnv,
      ...commandScope(pushRewrites(['acme-inc', 'acme-labs']))
    }
    const pushUrl = (name: string) =>
      gitOk(['remote', 'get-url', '--push', name], { cwd: repo, env })
    expect(pushUrl('allowedScp')).toBe('git@github.com:acme-inc/app.git')
    expect(pushUrl('allowedHttps')).toBe('https://github.com/acme-labs/app.git')
    expect(pushUrl('otherScp')).toBe('aiborg-blocked://contoso-org/app.git')
    expect(pushUrl('otherHttps')).toBe('aiborg-blocked://contoso-org/app.git')
    expect(pushUrl('otherSsh')).toBe('aiborg-blocked://contoso-org/app.git')
    expect(pushUrl('lookalike')).toBe('aiborg-blocked://acme-inc-evil/app.git')
  })

  it('does not rewrite an explicit pushurl (the gap the pre-push hook covers)', () => {
    addRemotes(repo, { origin: 'git@github.com:acme-inc/app.git' })
    gitOk(['config', 'remote.origin.pushurl', 'git@github.com:contoso-org/app.git'], { cwd: repo })
    const env = { ...baseEnv, ...commandScope(pushRewrites(['acme-inc'])) }
    expect(gitOk(['remote', 'get-url', '--push', 'origin'], { cwd: repo, env })).toBe(
      'git@github.com:contoso-org/app.git'
    )
  })

  it('runs the blocked remote helper from PATH for push and push --no-verify; hooks never run', () => {
    const hooks = join(sandbox.root, 'hooks')
    mkdirSync(hooks)
    writeExecutable(join(hooks, 'pre-push'), '#!/bin/sh\necho hook >> "$AIBORG_TEST_LOG"\nexit 0\n')
    const contosoBare = createBareRemote(remotes, 'contoso-org')
    addRemotes(repo, { origin: 'git@github.com:contoso-org/app.git' })
    const env = {
      ...baseEnv,
      ...commandScope([...pushRewrites(['acme-inc']), ['core.hooksPath', shPath(hooks)]])
    }
    for (const args of [
      ['push', 'origin', 'main'],
      ['push', '--no-verify', 'origin', 'main']
    ]) {
      const result = runGit(args, { cwd: repo, env })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        'AI-Borg: push blocked (aiborg-blocked://contoso-org/app.git)'
      )
    }
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['blocked', 'blocked'])
    expect(bareBranchHead(contosoBare)).toBeNull()
  })

  it('pushes an allowed org offline and hands the pre-push hook the GitHub URL and the refs on stdin', () => {
    const hooks = join(sandbox.root, 'hooks')
    mkdirSync(hooks)
    writeExecutable(
      join(hooks, 'pre-push'),
      '#!/bin/sh\nprintf "%s %s\\n" "$1" "$2" >> "$AIBORG_TEST_LOG"\ncat >> "$AIBORG_TEST_LOG"\n'
    )
    const acmeBare = createBareRemote(remotes, 'acme-inc')
    addRemotes(repo, { origin: 'git@github.com:acme-inc/app.git' })
    const env = {
      ...baseEnv,
      ...commandScope([...pushRewrites(['acme-inc']), ['core.hooksPath', shPath(hooks)]])
    }
    gitOk(['push', 'origin', 'main'], { cwd: repo, env })
    expect(bareBranchHead(acmeBare)).toBe(gitOk(['rev-parse', 'HEAD'], { cwd: repo }))
    const seen = readFileSync(log, 'utf8')
    expect(seen).toContain('origin git@github.com:acme-inc/app.git')
    expect(seen).toContain('refs/heads/main')
  })

  it('lets a command-scope core.hooksPath beat a repo-local one (husky, lefthook)', () => {
    const ours = join(sandbox.root, 'hooks')
    mkdirSync(ours)
    mkdirSync(join(repo, '.husky'))
    writeExecutable(join(ours, 'pre-commit'), '#!/bin/sh\necho ours >> "$AIBORG_TEST_LOG"\n')
    writeExecutable(
      join(repo, '.husky', 'pre-commit'),
      '#!/bin/sh\necho husky >> "$AIBORG_TEST_LOG"\n'
    )
    gitOk(['config', 'core.hooksPath', '.husky'], { cwd: repo })
    const env = {
      ...baseEnv,
      ...commandScope([['core.hooksPath', shPath(ours)]])
    }
    gitOk(
      [
        '-c',
        'user.name=x',
        '-c',
        'user.email=x@fixture.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'c'
      ],
      {
        cwd: repo,
        env
      }
    )
    expect(readFileSync(log, 'utf8').trim()).toBe('ours')
  })

  it('an empty "helper =" in the global file stops a system-scope credential helper', () => {
    const systemLog = join(sandbox.root, 'system-helper.log')
    const ghLog = join(sandbox.root, 'gh.log')
    const systemHelper = writeRecordingHelper(bin, 'fake-system-helper', systemLog)
    writeRecordingHelper(bin, 'gh', ghLog)
    gitOk(
      [
        'config',
        '--file',
        sandbox.gitSystemConfig,
        'credential.helper',
        `!${shPath(systemHelper)}`
      ],
      {
        cwd: repo
      }
    )
    const profileGlobal = join(sandbox.root, 'profile.gitconfig')
    writeFileSync(
      profileGlobal,
      '[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n'
    )
    const fill = (globalFile: string) =>
      runGit(['credential', 'fill'], {
        cwd: repo,
        env: { ...baseEnv, GIT_CONFIG_GLOBAL: globalFile },
        input: 'protocol=https\nhost=github.com\n\n'
      })

    fill(profileGlobal)
    expect(existsSync(systemLog)).toBe(false)
    expect(readFileSync(ghLog, 'utf8')).toContain('gh auth git-credential get')

    // Control: without the reset the system helper is consulted, so the assertion above is not vacuous.
    fill(baseEnv.GIT_CONFIG_GLOBAL)
    expect(readFileSync(systemLog, 'utf8')).toContain('fake-system-helper get')
  })

  it('GIT_CONFIG_GLOBAL hides ~/.gitconfig and a command-scope identity beats a repo-local one', () => {
    writeFileSync(join(sandbox.home, '.gitconfig'), '[user]\n\temail = personal@fixture.invalid\n')
    const profileGlobal = join(sandbox.root, 'profile.gitconfig')
    writeFileSync(profileGlobal, '[user]\n\temail = dev@acme.example\n')
    const userEmail = (env: NodeJS.ProcessEnv) =>
      gitOk(['config', 'user.email'], { cwd: repo, env })
    const withoutGlobal = { ...baseEnv }
    delete withoutGlobal.GIT_CONFIG_GLOBAL
    expect(userEmail(withoutGlobal)).toBe('personal@fixture.invalid')
    expect(userEmail({ ...baseEnv, GIT_CONFIG_GLOBAL: profileGlobal })).toBe('dev@acme.example')
    gitOk(['config', 'user.email', 'repo-local@fixture.invalid'], {
      cwd: repo
    })
    expect(
      userEmail({
        ...baseEnv,
        GIT_CONFIG_GLOBAL: profileGlobal,
        ...commandScope([['user.email', 'dev@acme.example']])
      })
    ).toBe('dev@acme.example')
  })
})
