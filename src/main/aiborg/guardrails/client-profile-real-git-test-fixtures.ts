// Offline real-git fixtures: local bare "GitHub" remotes behind a fake ssh, fake credential helpers.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { pathKeys } from './client-profile-test-fixtures'

export type GitResult = { status: number; stdout: string; stderr: string }

export type GitRunOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  input?: string
}

export function runGit(args: readonly string[], options: GitRunOptions): GitResult {
  const result = spawnSync('git', [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000
  })
  if (result.error) {
    throw result.error
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr
  }
}

export function gitOk(args: readonly string[], options: GitRunOptions): string {
  const result = runGit(args, options)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}):\n${result.stderr}`)
  }
  return result.stdout.trim()
}

/** Forward slashes: these paths end up inside sh command strings on Windows. */
export function shPath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function writeExecutable(path: string, content: string): string {
  writeFileSync(path, content.replace(/\r\n/g, '\n'))
  chmodSync(path, 0o755)
  return path
}

/** A repo with one commit on `main`; identity is passed per command so no local user.* exists. */
export function initRepo(path: string, env?: NodeJS.ProcessEnv): string {
  mkdirSync(path, { recursive: true })
  gitOk(['init', '--quiet', '--initial-branch=main'], { cwd: path, env })
  gitOk(['config', 'commit.gpgSign', 'false'], { cwd: path, env })
  writeFileSync(join(path, 'README.md'), 'fixture\n')
  gitOk(['add', 'README.md'], { cwd: path, env })
  commitAs(path, 'init', env)
  return path
}

export function commitAs(repo: string, message: string, env?: NodeJS.ProcessEnv): void {
  gitOk(
    [
      '-c',
      'user.name=Fixture Setup',
      '-c',
      'user.email=setup@fixture.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      message
    ],
    { cwd: repo, env }
  )
}

export function createBareRemote(remotesRoot: string, org: string, name = 'app'): string {
  const path = join(remotesRoot, org, `${name}.git`)
  mkdirSync(path, { recursive: true })
  gitOk(['init', '--quiet', '--bare', '--initial-branch=main'], { cwd: path })
  return path
}

export function bareBranchHead(barePath: string, branch = 'main'): string | null {
  const result = runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: barePath
  })
  return result.status === 0 ? result.stdout.trim() : null
}

/**
 * Serves `git@github.com:<org>/<repo>` and `ssh://git@github.com/<org>/<repo>` from
 * `<remotesRoot>/<org>/<repo>`, so pushes run offline while hooks still see GitHub URLs.
 */
export function fakeGitHubSshEnv(binDir: string, remotesRoot: string): Record<string, string> {
  mkdirSync(binDir, { recursive: true })
  const script = writeExecutable(
    join(binDir, 'fake-github-ssh'),
    [
      '#!/bin/sh',
      '# Offline stand-in for ssh: the last argument is the remote git command.',
      'for last in "$@"; do :; done',
      'service=${last%% *}',
      'repo=${last#* }',
      "repo=${repo#\\'}; repo=${repo%\\'}; repo=${repo#/}",
      'exec git "${service#git-}" "$AIBORG_TEST_REMOTES/$repo"',
      ''
    ].join('\n')
  )
  return {
    GIT_SSH_COMMAND: `"${shPath(script)}"`,
    // Why: skips the `-G` probe git runs for an unrecognised ssh command.
    GIT_SSH_VARIANT: 'simple',
    AIBORG_TEST_REMOTES: shPath(remotesRoot)
  }
}

/** A credential helper that records every call to `logFile` and answers nothing. */
export function writeRecordingHelper(binDir: string, name: string, logFile: string): string {
  mkdirSync(binDir, { recursive: true })
  return writeExecutable(
    join(binDir, name),
    ['#!/bin/sh', `echo "${name} $*" >> "${shPath(logFile)}"`, 'cat > /dev/null', ''].join('\n')
  )
}

/** Prepends `dir` to every PATH spelling in `env` (adds PATH when there is none). */
export function withPathPrefix(env: Record<string, string>, dir: string): Record<string, string> {
  const next = { ...env }
  const keys = pathKeys(next)
  for (const key of keys.length > 0 ? keys : ['PATH']) {
    next[key] = next[key] ? `${dir}${delimiter}${next[key]}` : dir
  }
  return next
}

export function gitLfsAvailable(): boolean {
  const result = spawnSync('git', ['lfs', 'version'], {
    encoding: 'utf8',
    windowsHide: true
  })
  return result.status === 0
}

/** Commit-free push setup: one repo, `main` checked out, a remote per name→url. */
export function addRemotes(
  repo: string,
  remotes: Record<string, string>,
  env?: NodeJS.ProcessEnv
): void {
  for (const [name, url] of Object.entries(remotes)) {
    gitOk(['remote', 'add', name, url], { cwd: repo, env })
  }
}
