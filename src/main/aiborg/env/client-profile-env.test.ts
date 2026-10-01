import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateClientProfile } from '../../../shared/aiborg/client-profile-schema'
import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { CLIENT_PROFILE_MANAGED_ENV_KEYS } from '../../../shared/aiborg/client-profile-env-keys'
import { buildClientProfileEnv } from './client-profile-env'

const ROOT = join('/tmp', 'aiborg-test-profiles')

function profile(raw: Record<string, unknown>): ClientProfile {
  const result = validateClientProfile({
    schemaVersion: 1,
    name: 'Acme',
    color: '#2F80ED',
    github: { allowedOrgs: ['acme-inc'] },
    git: { userName: 'Example Name', userEmail: 'dev@acme.example' },
    ...raw
  })
  if (!result.ok) {
    throw new Error(result.errors.join('; '))
  }
  return result.profile
}

const acme = profile({
  id: 'acme',
  aws: { profile: 'acme-dev', region: 'eu-west-1' },
  gcloud: { project: 'acme-prod-123' },
  secrets: { GH_TOKEN: {}, SUPABASE_ACCESS_TOKEN: {}, ACME_DB_TOKEN: {} },
  env: { ACME_STAGE: 'dev' },
  remote: { allow: true, envAllowlist: ['ACME_STAGE'] }
})
const contoso = profile({
  id: 'contoso',
  name: 'Contoso',
  github: { allowedOrgs: ['contoso-org'] },
  env: { CONTOSO_REGION: 'west' }
})

const SECRETS = { GH_TOKEN: 'fixture-gh-value', SUPABASE_ACCESS_TOKEN: 'fixture-supabase-value' }

describe('buildClientProfileEnv (local)', () => {
  const plan = buildClientProfileEnv(acme, SECRETS, {
    kind: 'local',
    platform: 'linux',
    root: ROOT,
    allProfiles: [acme, contoso],
    basePath: '/usr/bin'
  })
  const P = join(ROOT, 'acme')

  it('sets every §3.1 variable', () => {
    expect(plan.set).toMatchObject({
      AIBORG_PROFILE_ID: 'acme',
      AIBORG_PROFILE_NAME: 'Acme',
      AIBORG_PROFILE_COLOR: '#2F80ED',
      AIBORG_ALLOWED_ORGS: 'acme-inc',
      PATH: `${join(P, 'bin')}:/usr/bin`,
      GIT_CONFIG_GLOBAL: join(P, 'gitconfig'),
      GH_TOKEN: 'fixture-gh-value',
      GH_CONFIG_DIR: join(P, 'gh'),
      CLAUDE_CONFIG_DIR: join(P, 'claude'),
      CODEX_HOME: join(P, 'codex'),
      ORCA_CODEX_HOME: join(P, 'codex'),
      AWS_CONFIG_FILE: join(P, 'aws', 'config'),
      AWS_SHARED_CREDENTIALS_FILE: join(P, 'aws', 'credentials'),
      AWS_PROFILE: 'acme-dev',
      AWS_REGION: 'eu-west-1',
      AZURE_CONFIG_DIR: join(P, 'azure'),
      CLOUDSDK_CONFIG: join(P, 'gcloud'),
      CLOUDSDK_CORE_PROJECT: 'acme-prod-123',
      SUPABASE_ACCESS_TOKEN: 'fixture-supabase-value',
      ACME_STAGE: 'dev'
    })
    expect(plan.set.GIT_SSH_COMMAND).toMatch(
      /^ssh -F ".*\/ssh\/config" -o IdentitiesOnly=yes -o BatchMode=yes -i ".*\/ssh\/id_ed25519\.pub"$/
    )
  })

  it("deletes every managed key it does not set, including other profiles' keys", () => {
    const managed = new Set([...CLIENT_PROFILE_MANAGED_ENV_KEYS, 'CONTOSO_REGION', 'ACME_DB_TOKEN'])
    for (const key of managed) {
      expect(key in plan.set !== plan.delete.includes(key)).toBe(true)
    }
    expect(plan.delete).toEqual(
      expect.arrayContaining(['GITHUB_TOKEN', 'OPENAI_API_KEY', 'CONTOSO_REGION', 'ACME_DB_TOKEN'])
    )
    expect(plan.missingSecrets).toEqual(['ACME_DB_TOKEN'])
  })

  it('records what the shell restore snippet re-applies', () => {
    expect(plan.set.AIBORG_PROFILE_BIN).toBe(join(P, 'bin'))
    expect(plan.set.AIBORG_PROFILE_KEYS.split(' ')).toContain('GH_TOKEN')
    expect(plan.set.AIBORG_PROFILE_KEYS.split(' ')).not.toContain('PATH')
    expect(plan.set.AIBORG_KEEP_CLAUDE_CONFIG_DIR).toBe(join(P, 'claude'))
    expect(plan.set.AIBORG_PROFILE_UNSET.split(' ')).toEqual(plan.delete)
  })

  it('adds the command-scope git config (hooksPath, identity, pushInsteadOf)', () => {
    const keys = plan.gitConfigEntries.map(([key]) => key)
    expect(keys.slice(0, 3)).toEqual(['core.hooksPath', 'user.name', 'user.email'])
    expect(plan.gitConfigEntries).toContainEqual([
      'url.aiborg-blocked://.pushInsteadOf',
      'https://github.com/'
    ])
    expect(plan.gitConfigEntries).toContainEqual([
      'url.git@github.com:acme-inc/.pushInsteadOf',
      'git@github.com:acme-inc/'
    ])
  })
})

describe('buildClientProfileEnv (targets and platforms)', () => {
  it('uses System32 OpenSSH and ; on Windows', () => {
    const plan = buildClientProfileEnv(
      acme,
      {},
      {
        kind: 'local',
        platform: 'win32',
        root: 'C:\\Users\\example\\.aiborg\\profiles',
        basePath: 'C:\\Windows',
        systemEnv: { SystemRoot: 'C:\\Windows' }
      }
    )
    expect(plan.set.GIT_SSH_COMMAND.startsWith('"C:/Windows/System32/OpenSSH/ssh.exe" ')).toBe(true)
    expect(plan.set.PATH.endsWith(';C:\\Windows')).toBe(true)
  })

  it('sets SSH_AUTH_SOCK only on macOS when configured', () => {
    const mac = buildClientProfileEnv(
      acme,
      {},
      { kind: 'local', platform: 'darwin', root: ROOT, machine: { sshAuthSock: '/tmp/agent.sock' } }
    )
    const linux = buildClientProfileEnv(
      acme,
      {},
      { kind: 'local', platform: 'linux', root: ROOT, machine: { sshAuthSock: '/tmp/agent.sock' } }
    )
    expect(mac.set.SSH_AUTH_SOCK).toBe('/tmp/agent.sock')
    expect('SSH_AUTH_SOCK' in linux.set).toBe(false)
    expect(linux.delete).not.toContain('SSH_AUTH_SOCK')
  })

  it('sends only AIBORG_PROFILE_* and the allowlist over SSH (§3.4), no local paths or secrets', () => {
    const plan = buildClientProfileEnv(acme, SECRETS, {
      kind: 'ssh',
      platform: 'linux',
      root: ROOT
    })
    expect(plan.set).toEqual({
      AIBORG_PROFILE_ID: 'acme',
      AIBORG_PROFILE_NAME: 'Acme',
      AIBORG_PROFILE_COLOR: '#2F80ED',
      ACME_STAGE: 'dev'
    })
    expect(JSON.stringify(plan)).not.toContain(ROOT)
    expect(JSON.stringify(plan)).not.toContain('fixture-gh-value')
    expect(plan.gitConfigEntries).toEqual([])
    expect(plan.delete).toContain('GH_TOKEN')
  })

  it('refuses SSH without remote.allow, and WSL always', () => {
    expect(() => buildClientProfileEnv(contoso, {}, { kind: 'ssh', root: ROOT })).toThrow(
      /does not allow SSH/
    )
    expect(() => buildClientProfileEnv(acme, {}, { kind: 'wsl', root: ROOT })).toThrow(/WSL/)
  })
})
