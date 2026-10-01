import { describe, expect, it } from 'vitest'
import {
  buildClientProfileFromForm,
  createEmptyClientProfileForm,
  parseAllowedOrgs,
  validateNewClientProfileForm,
  type NewClientProfileForm
} from './new-client-profile-form'

function acmeForm(overrides: Partial<NewClientProfileForm> = {}): NewClientProfileForm {
  return {
    ...createEmptyClientProfileForm(),
    id: 'acme',
    name: 'Acme',
    allowedOrgs: 'acme-inc, Acme-Labs acme-inc',
    gitUserName: 'Example Name',
    gitUserEmail: 'dev@acme.example',
    ...overrides
  }
}

describe('new client profile form', () => {
  it('parses org lists separated by commas or spaces, lower-cased and de-duplicated', () => {
    expect(parseAllowedOrgs(' acme-inc,Acme-Labs  acme-inc ')).toEqual(['acme-inc', 'acme-labs'])
  })

  it('builds a valid acme profile with references only', () => {
    const profile = buildClientProfileFromForm(
      acmeForm({
        ghTokenBitwarden: 'acme / GitHub fine-grained PAT',
        tools: {
          ...createEmptyClientProfileForm().tools,
          supabase: true,
          aws: true
        },
        awsProfile: 'acme-dev'
      })
    )
    expect(profile).toMatchObject({
      schemaVersion: 1,
      id: 'acme',
      github: { host: 'github.com', allowedOrgs: ['acme-inc', 'acme-labs'] },
      git: { userName: 'Example Name', userEmail: 'dev@acme.example' },
      aws: { profile: 'acme-dev' },
      secrets: {
        GH_TOKEN: { bitwarden: 'acme / GitHub fine-grained PAT' },
        SUPABASE_ACCESS_TOKEN: {}
      }
    })
    expect(profile.azure).toBeUndefined()
    expect(validateNewClientProfileForm(acmeForm(), [])).toEqual([])
  })

  it('rejects a duplicate id, an empty org list and a missing AWS profile', () => {
    const errors = validateNewClientProfileForm(
      acmeForm({
        allowedOrgs: '',
        tools: { ...createEmptyClientProfileForm().tools, aws: true }
      }),
      ['acme', 'contoso']
    )
    expect(errors[0]).toContain('already used')
    expect(errors.some((error) => error.includes('allowedOrgs'))).toBe(true)
    expect(errors.some((error) => error.startsWith('aws.profile'))).toBe(true)
  })

  it('rejects an invalid id and token-shaped values', () => {
    const errors = validateNewClientProfileForm(
      acmeForm({ id: 'Acme Corp', name: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }),
      []
    )
    expect(errors.some((error) => error.includes('looks like a secret'))).toBe(true)
    expect(errors.some((error) => error.startsWith('id'))).toBe(true)
  })
})
