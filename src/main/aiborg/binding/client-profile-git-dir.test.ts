import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findGitCommonDir,
  gitConfigHasIncludes,
  parseGitConfigRemotePushUrls
} from './client-profile-git-dir'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('git config remote parsing (no git spawn)', () => {
  it('reads url, prefers pushurl, and handles quoting, comments and legacy sections', () => {
    const config = [
      '[core]',
      '\tbare = false',
      '[remote "origin"]',
      '\turl = https://github.com/acme-inc/app.git # fetch',
      '\tpushurl = "git@github.com:acme-labs/app.git" ; push',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[remote "the \\"fork\\""]',
      '\tURL = ssh://git@github.com/contoso-org/app.git',
      '[remote.legacy]',
      '\turl = https://github.com/example-oss/app.git',
      '[branch "main"]',
      '\tremote = origin'
    ].join('\n')
    expect(parseGitConfigRemotePushUrls(config)).toEqual([
      { name: 'origin', pushUrls: ['git@github.com:acme-labs/app.git'] },
      { name: 'the "fork"', pushUrls: ['ssh://git@github.com/contoso-org/app.git'] },
      { name: 'legacy', pushUrls: ['https://github.com/example-oss/app.git'] }
    ])
  })

  it('flags includes, which only git itself can follow', () => {
    expect(gitConfigHasIncludes('[includeIf "gitdir:~/w/"]\n\tpath = x')).toBe(true)
    expect(gitConfigHasIncludes('[include]\n\tpath = x')).toBe(true)
    expect(gitConfigHasIncludes('[remote "origin"]\n\turl = x')).toBe(false)
  })
})

describe('git common dir (no git spawn)', () => {
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'aiborg-gitdir-'))
    temps.push(dir)
    return dir
  }

  it('finds the shared dir from a nested path, a linked worktree and a bare repo', () => {
    const root = tempDir()
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.git', 'worktrees', 'feature'), { recursive: true })
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
    expect(findGitCommonDir(join(repo, 'src', 'deep'))).toBe(resolve(repo, '.git'))

    const linked = join(root, 'elsewhere', 'feature')
    mkdirSync(linked, { recursive: true })
    writeFileSync(join(linked, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'feature')}\n`)
    writeFileSync(join(repo, '.git', 'worktrees', 'feature', 'commondir'), '../..\n')
    expect(findGitCommonDir(linked)).toBe(resolve(repo, '.git'))

    const bare = join(root, 'bare.git')
    mkdirSync(join(bare, 'objects'), { recursive: true })
    writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n')
    expect(findGitCommonDir(bare)).toBe(resolve(bare))
  })
})
