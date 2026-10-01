import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateClientProfile } from '../../../shared/aiborg/client-profile-schema'
import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import {
  ensureClientProfileHome,
  isGitVersionSupportedForClientProfiles,
  removeClientProfileHome
} from './client-profile-dirs'
import { clientProfileHomeLayout, resolveClientProfilesRoot } from './client-profile-paths'
import { parseSafeDirectories } from './client-profile-git-templates'
import { CLIENT_PROFILE_CHAINED_HOOK_NAMES } from './client-profile-hook-templates'

function acme(raw: Record<string, unknown> = {}): ClientProfile {
  const result = validateClientProfile({
    schemaVersion: 1,
    id: 'acme',
    name: 'Acme',
    color: '#2F80ED',
    github: { allowedOrgs: ['acme-inc', 'acme-labs'] },
    git: { userName: 'Example "Quoted" Name', userEmail: 'dev@acme.example' },
    ...raw
  })
  if (!result.ok) {
    throw new Error(result.errors.join('; '))
  }
  return result.profile
}

const temps: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiborg-dirs-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('paths', () => {
  it('honours AIBORG_PROFILES_ROOT and refuses ids that could escape the root', () => {
    expect(resolveClientProfilesRoot({ AIBORG_PROFILES_ROOT: '/srv/p' }, '/home/x')).toMatch(
      /[\\/]srv[\\/]p$/
    )
    expect(resolveClientProfilesRoot({}, '/home/x')).toMatch(
      /[\\/]home[\\/]x[\\/]\.aiborg[\\/]profiles$/
    )
    expect(() => clientProfileHomeLayout('/r', '../x')).toThrow(/Invalid client profile id/)
  })
})

describe('ensureClientProfileHome', () => {
  it('writes the tool dirs, gitconfig, ssh config, hooks and the blocked-remote helper', async () => {
    const dir = temp()
    const home = join(dir, 'home')
    const root = join(dir, 'profiles')
    writeFileSync(
      join(dir, 'user-gitconfig'),
      '[safe]\n\tdirectory = /work/shared\n\tdirectory = "C:\\\\work\\\\x"\n'
    )
    const layout = await ensureClientProfileHome(acme(), {
      root,
      machine: { sshAuthSock: null, windowsSsh: null },
      platform: 'win32',
      env: { GIT_CONFIG_GLOBAL: join(dir, 'user-gitconfig'), SystemRoot: 'C:\\Windows' },
      home
    })
    for (const tool of [
      'gh',
      'claude',
      'codex',
      'aws',
      'azure',
      'gcloud',
      'ssh',
      'mcp',
      'hooks',
      'bin'
    ]) {
      expect(statSync(join(layout.home, tool)).isDirectory()).toBe(true)
    }
    const gitconfig = readFileSync(layout.gitconfig, 'utf8')
    expect(gitconfig).toContain('name = "Example \\"Quoted\\" Name"')
    expect(gitconfig).toContain('[filter "lfs"]')
    expect(gitconfig).toContain('\tlongpaths = true')
    expect(gitconfig).toMatch(
      /\[credential\]\n\thelper =\n\[credential "https:\/\/github\.com"\]\n\thelper =\n\thelper = !gh auth git-credential/
    )
    expect(gitconfig).toContain('directory = "/work/shared"')
    expect(gitconfig).toContain('directory = "C:\\\\work\\\\x"')
    expect(gitconfig).toContain(
      '[url "aiborg-blocked://"]\n\tpushInsteadOf = "https://github.com/"'
    )
    expect(gitconfig).toContain(
      '[url "git@github.com:acme-labs/"]\n\tpushInsteadOf = "git@github.com:acme-labs/"'
    )
    expect(gitconfig).toContain('sshCommand = "\\"C:/Windows/System32/OpenSSH/ssh.exe\\" -F')
    expect(gitconfig).not.toContain('[include]')
    const prePush = readFileSync(join(layout.hooks, 'pre-push'), 'utf8')
    expect(prePush.startsWith('#!/bin/sh\n')).toBe(true)
    expect(prePush).toContain("allowed='acme-inc acme-labs'")
    expect(prePush).not.toContain('\r')
    for (const name of CLIENT_PROFILE_CHAINED_HOOK_NAMES) {
      const stub = readFileSync(join(layout.hooks, name), 'utf8')
      // One sh per hook event: the chain is inlined, and git runs only on the slow path.
      expect(stub).toContain(`name='${name}'`)
      expect(stub).not.toContain('exec sh')
      expect(stub.indexOf('git config --local')).toBeGreaterThan(stub.indexOf('if [ -z "$dir" ]'))
    }
    expect(readFileSync(join(layout.bin, 'aiborg-prompt.ps1'), 'utf8')).toContain(
      '__AiborgPromptPrefix'
    )
    expect(readFileSync(join(layout.bin, 'git-remote-aiborg-blocked'), 'utf8')).toContain(
      '"via":"rewrite"'
    )
    expect(readFileSync(layout.sshConfig, 'utf8')).toContain('IdentitiesOnly yes')
  })

  it('includes the global gitconfig first only when asked', async () => {
    const dir = temp()
    const layout = await ensureClientProfileHome(
      acme({ git: { userName: 'n', userEmail: 'a@acme.example', includeGlobalGitconfig: true } }),
      {
        root: dir,
        machine: { sshAuthSock: null, windowsSsh: null },
        platform: 'linux',
        env: {},
        home: dir
      }
    )
    const gitconfig = readFileSync(layout.gitconfig, 'utf8')
    expect(gitconfig.indexOf('[include]')).toBeLessThan(gitconfig.indexOf('[credential]'))
    expect(gitconfig).not.toContain('longpaths')
  })

  it('removes the whole profile home', async () => {
    const dir = temp()
    const layout = await ensureClientProfileHome(acme(), {
      root: dir,
      machine: { sshAuthSock: null, windowsSsh: null },
      env: {},
      home: dir
    })
    await removeClientProfileHome(dir, 'acme')
    expect(() => statSync(layout.home)).toThrow()
  })
})

describe('git helpers', () => {
  it('requires git 2.32', () => {
    expect(isGitVersionSupportedForClientProfiles('git version 2.31.9')).toBe(false)
    expect(isGitVersionSupportedForClientProfiles('git version 2.32.0.windows.1')).toBe(true)
    expect(isGitVersionSupportedForClientProfiles('git version 3.0.0')).toBe(true)
    expect(isGitVersionSupportedForClientProfiles('garbage')).toBe(false)
  })

  it('parses safe.directory only from [safe] sections', () => {
    expect(
      parseSafeDirectories(
        '[core]\ndirectory = no\n[safe]\n  directory = /a ; comment\n[Safe]\ndirectory=*\n'
      )
    ).toEqual(['/a', '*'])
  })
})
