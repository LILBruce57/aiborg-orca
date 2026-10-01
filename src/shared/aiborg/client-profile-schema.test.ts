import { describe, expect, it } from 'vitest'
import {
  findClientProfileForOwner,
  findCredentialLookalikes,
  isSafeProfileRelativePath,
  validateClientProfile,
  validateClientProfileSet
} from './client-profile-schema'

function acme(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'acme',
    name: 'Acme',
    color: '#2F80ED',
    github: { host: 'github.com', allowedOrgs: ['acme-inc', 'Acme-Labs'] },
    git: { userName: 'Example Name', userEmail: 'dev@acme.example' },
    secrets: { GH_TOKEN: { bitwarden: 'acme / GitHub' } },
    env: { ACME_STAGE: 'dev' },
    remote: { allow: false, envAllowlist: [] },
    ...overrides
  }
}

function errorsOf(raw: unknown, fileName = 'acme.json'): string[] {
  const result = validateClientProfile(raw, fileName)
  return result.ok ? [] : result.errors
}

describe('validateClientProfile', () => {
  it('accepts a valid profile and lower-cases allowed orgs', () => {
    const result = validateClientProfile(acme(), 'acme.json')
    expect(result.ok).toBe(true)
    expect(result.ok && result.profile.github.allowedOrgs).toEqual(['acme-inc', 'acme-labs'])
  })

  it('defaults the GitHub host', () => {
    const result = validateClientProfile(acme({ github: { allowedOrgs: ['acme-inc'] } }), 'acme')
    expect(result.ok && result.profile.github.host).toBe('github.com')
  })

  it.each([
    ['ghp_', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['github_pat_', 'github_pat_11ABCDEFG0123456789_abcdefghij'],
    ['sk-', 'sk-abcdefghijklmnop1234'],
    ['AKIA', 'AKIAABCDEFGHIJKLMNOP'],
    ['xox', 'xoxb-1234567890-abcdef'],
    ['PEM', '-----BEGIN OPENSSH PRIVATE KEY-----']
  ])('rejects a %s token-shaped value anywhere', (_label, token) => {
    expect(errorsOf(acme({ env: { ACME_NOTE: token } })).join('\n')).toMatch(
      /looks like a secret value/
    )
    expect(errorsOf(acme({ name: token })).join('\n')).toMatch(/name: looks like a secret value/)
  })

  it.each(['ACME_TOKEN', 'DB_PASSWORD', 'CLIENT_SECRET_ID', 'API_KEY'])(
    'rejects the secret-like env key %s',
    (key) => {
      expect(errorsOf(acme({ env: { [key]: 'x' } })).join('\n')).toMatch(/move it to "secrets"/)
    }
  )

  it('rejects env keys AI-Borg derives', () => {
    expect(errorsOf(acme({ env: { PATH: '/x' } })).join('\n')).toMatch(/managed by AI-Borg/)
    expect(errorsOf(acme({ env: { GIT_CONFIG_COUNT: '1' } })).join('\n')).toMatch(
      /managed by AI-Borg/
    )
    expect(errorsOf(acme({ secrets: { CLAUDE_CONFIG_DIR: {} } })).join('\n')).toMatch(/managed/)
  })

  it('requires the id to equal the file name', () => {
    expect(errorsOf(acme(), 'contoso.json').join('\n')).toMatch(/must equal the file name/)
    expect(errorsOf(acme(), 'acme')).toEqual([])
  })

  it('rejects bad ids, colours, empty org lists and unknown keys', () => {
    expect(errorsOf(acme({ id: 'A' }), 'A')).not.toEqual([])
    expect(errorsOf(acme({ color: 'blue' }))).not.toEqual([])
    expect(errorsOf(acme({ github: { allowedOrgs: [] } })).join('\n')).toMatch(/must not be empty/)
    expect(errorsOf(acme({ surprise: true }))).not.toEqual([])
  })

  it('keeps relative paths inside the profile home', () => {
    expect(
      errorsOf(acme({ git: { userName: 'n', userEmail: 'a@b', sshPublicKey: '../x.pub' } }))
    ).not.toEqual([])
    expect(isSafeProfileRelativePath('ssh/id_ed25519.pub')).toBe(true)
    for (const bad of ['/etc/x', 'C:/x', '~/x', 'ssh/../../x', '\\\\server\\x']) {
      expect(isSafeProfileRelativePath(bad)).toBe(false)
    }
  })

  it('limits the SSH allowlist to plain env keys', () => {
    expect(
      errorsOf(acme({ remote: { allow: true, envAllowlist: ['GH_TOKEN'] } })).join('\n')
    ).toMatch(/not a plain env key/)
    expect(errorsOf(acme({ remote: { allow: true, envAllowlist: ['ACME_STAGE'] } }))).toEqual([])
  })

  it('reports where a secret-shaped key or value sits', () => {
    expect(findCredentialLookalikes({ a: ['ok', 'ghp_abcdefghijklmnopqrstuvwxyz0123'] })).toEqual([
      'a[1]'
    ])
  })
})

describe('profile sets and repo matching', () => {
  const profileA = validateClientProfile(acme(), 'acme')
  const profileB = validateClientProfile(
    acme({ id: 'contoso', name: 'Contoso', github: { allowedOrgs: ['contoso-org', 'acme-inc'] } }),
    'contoso'
  )

  it('flags an org listed in two profiles', () => {
    if (!profileA.ok || !profileB.ok) {
      throw new Error('fixtures must validate')
    }
    expect(validateClientProfileSet([profileA.profile, profileB.profile])).toEqual([
      'org github.com/acme-inc is listed in more than one profile: acme, contoso'
    ])
  })

  it('matches an owner to exactly one profile, case-insensitively', () => {
    if (!profileA.ok || !profileB.ok) {
      throw new Error('fixtures must validate')
    }
    const profiles = [profileA.profile, profileB.profile]
    expect(findClientProfileForOwner(profiles, 'github.com', 'Contoso-Org')?.id).toBe('contoso')
    expect(findClientProfileForOwner(profiles, 'github.com', 'acme-inc')).toBeNull()
    expect(findClientProfileForOwner(profiles, 'github.com', 'someone-else')).toBeNull()
  })
})
