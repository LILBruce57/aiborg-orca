// T1 (design §1.2, §7). Needs the Phase 2 implementation: client-profile-schema.ts.
import { describe, expect, it, vi } from 'vitest'
import { acmeProfileJson, contosoProfileJson } from './client-profile-test-fixtures'
import { clientProfiles } from './client-profile-test-harness'

vi.mock(
  'electron',
  async () => (await import('./client-profile-electron-test-fixture')).electronModule
)
vi.mock(
  '@napi-rs/keyring',
  async () => (await import('./client-profile-keyring-test-fixture')).keyringModule
)

// Token shapes are assembled at runtime so no literal here trips a secret scanner.
const fake = (prefixParts: string[], body: string): string => [...prefixParts, body].join('')
const TOKEN_SHAPES: Record<string, string> = {
  'classic GitHub PAT': fake(['gh', 'p_'], 'x'.repeat(36)),
  'fine-grained GitHub PAT': fake(['github', '_pat_'], `11${'A'.repeat(20)}_${'b'.repeat(59)}`),
  'OpenAI-style key': fake(['s', 'k-'], `proj-${'z'.repeat(40)}`),
  'AWS access key id': fake(['AK', 'IA'], 'EXAMPLEEXAMPLE00'),
  'Slack token': fake(['xo', 'xb-'], `000000000000-000000000000-${'q'.repeat(24)}`),
  'PEM private key': fake(
    ['-----BEGIN ', 'OPENSSH PRIVATE KEY-----'],
    '\nAAAA\n-----END OPENSSH PRIVATE KEY-----'
  )
}

function expectInvalid(raw: unknown, fileName = 'acme.json'): string[] {
  const result = clientProfiles.validateProfile(raw, fileName)
  expect(result.ok).toBe(false)
  return result.ok ? [] : result.errors
}

describe('T1 schema rejects secrets', () => {
  it('accepts the acme and contoso fixtures', () => {
    expect(clientProfiles.validateProfile(acmeProfileJson(), 'acme.json')).toMatchObject({
      ok: true
    })
    expect(clientProfiles.validateProfile(contosoProfileJson(), 'contoso.json')).toMatchObject({
      ok: true
    })
  })

  it.each(Object.entries(TOKEN_SHAPES))('rejects a %s in an env value', (_label, token) => {
    expectInvalid(acmeProfileJson({ env: { ACME_STAGE: token } }))
  })

  it.each(Object.entries(TOKEN_SHAPES))(
    'rejects a %s in any other string field',
    (_label, token) => {
      expectInvalid(
        acmeProfileJson({
          github: {
            host: 'github.com',
            allowedOrgs: ['acme-inc'],
            login: token
          }
        })
      )
      expectInvalid(
        acmeProfileJson({
          mcp: {
            claude: {
              'example-server': { command: 'npx', args: ['-y', token] }
            }
          }
        })
      )
      expectInvalid(acmeProfileJson({ aws: { profile: token, region: 'eu-west-1' } }))
    }
  )

  it('rejects a literal secret value where a secret reference belongs', () => {
    expectInvalid(
      acmeProfileJson({
        secrets: { GH_TOKEN: TOKEN_SHAPES['classic GitHub PAT'] }
      })
    )
    expectInvalid(acmeProfileJson({ secrets: { GH_TOKEN: 'plain-text-value' } }))
  })

  it.each(['ACME_API_TOKEN', 'CLIENT_SECRET', 'DB_PASSWORD', 'SIGNING_KEY', 'GH_TOKEN'])(
    'rejects the secret-like env key %s (it must be a secrets ref)',
    (key) => {
      expectInvalid(
        acmeProfileJson({
          env: { ACME_STAGE: 'acme-stage-dev', [key]: 'not-a-secret-shape' }
        })
      )
    }
  )

  it('allows env keys that only contain KEY mid-name', () => {
    expect(
      clientProfiles.validateProfile(
        acmeProfileJson({
          env: { ACME_STAGE: 'acme-stage-dev', KEYBOARD_LAYOUT: 'us' }
        }),
        'acme.json'
      )
    ).toMatchObject({ ok: true })
  })

  it('requires id to match the pattern and equal the file name', () => {
    expectInvalid(acmeProfileJson(), 'contoso.json')
    expectInvalid(acmeProfileJson({ id: 'Acme' }), 'Acme.json')
    expectInvalid(acmeProfileJson({ id: 'a' }), 'a.json')
    const long = 'a'.repeat(33)
    expectInvalid(acmeProfileJson({ id: long }), `${long}.json`)
    expectInvalid(acmeProfileJson({ id: 'acme_inc' }), 'acme_inc.json')
  })

  it('requires a hex colour, a non-empty allowedOrgs and schema version 1', () => {
    expectInvalid(acmeProfileJson({ color: 'blue' }))
    expectInvalid(acmeProfileJson({ color: 'var(--x)' }))
    expectInvalid(acmeProfileJson({ github: { host: 'github.com', allowedOrgs: [] } }))
    expectInvalid(acmeProfileJson({ schemaVersion: 2 }))
  })

  it('rejects relative paths that escape the profile home', () => {
    expectInvalid(
      acmeProfileJson({
        git: {
          userName: 'Example Acme Dev',
          userEmail: 'dev@acme.example',
          sshPublicKey: '../../.ssh/id_ed25519.pub',
          includeGlobalGitconfig: false
        }
      })
    )
  })

  it('never echoes a rejected secret value in its errors', () => {
    const token = TOKEN_SHAPES['classic GitHub PAT']
    const errors = expectInvalid(acmeProfileJson({ env: { ACME_STAGE: token } }))
    expect(errors.join('\n')).not.toContain(token)
  })
})
