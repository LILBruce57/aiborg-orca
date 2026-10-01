import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateClientProfile } from '../../../shared/aiborg/client-profile-schema'
import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { ClientProfileKeychainUnavailableError } from '../keychain/client-profile-keychain'
import {
  applyClientProfileEnvPlan,
  buildClientProfileChildEnv,
  buildClientProfileProcessEnv,
  planClientProfileEnv,
  type ClientProfileEnvDeps
} from './apply-client-profile-env'

function acme(): ClientProfile {
  const result = validateClientProfile({
    schemaVersion: 1,
    id: 'acme',
    name: 'Acme',
    color: '#2F80ED',
    github: { allowedOrgs: ['acme-inc'] },
    git: { userName: 'Example Name', userEmail: 'dev@acme.example' },
    secrets: { GH_TOKEN: {} }
  })
  if (!result.ok) {
    throw new Error(result.errors.join('; '))
  }
  return result.profile
}

function deps(overrides: Partial<ClientProfileEnvDeps> = {}): ClientProfileEnvDeps {
  return {
    root: join('/tmp', 'aiborg-apply-test'),
    machine: { sshAuthSock: null, windowsSsh: null },
    platform: 'linux',
    extraManagedKeys: [],
    readSecret: (_id, name) => (name === 'GH_TOKEN' ? 'fixture-gh-value' : null),
    systemEnv: {},
    ...overrides
  }
}

describe('planClientProfileEnv', () => {
  it('fills secrets from the keychain', () => {
    expect(planClientProfileEnv(acme(), { kind: 'local' }, {}, deps()).set.GH_TOKEN).toBe(
      'fixture-gh-value'
    )
  })

  it('refuses when the keychain is unavailable (no fallback)', () => {
    const unavailable = deps({
      readSecret: () => {
        throw new ClientProfileKeychainUnavailableError('test')
      }
    })
    expect(() => planClientProfileEnv(acme(), { kind: 'local' }, {}, unavailable)).toThrow(
      /keychain is unavailable/
    )
  })

  it('refuses an invalid incoming GIT_CONFIG_COUNT', () => {
    expect(() =>
      planClientProfileEnv(
        acme(),
        { kind: 'local' },
        { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a' },
        deps()
      )
    ).toThrow(/GIT_CONFIG_COUNT is invalid/)
  })

  it('refuses every profile on a host without a keychain (orcad)', () => {
    expect(() =>
      planClientProfileEnv(acme(), { kind: 'local' }, {}, deps({ refuseAllProfiles: true }))
    ).toThrow(/headless server/)
  })

  it('refuses WSL', () => {
    expect(() => planClientProfileEnv(acme(), { kind: 'wsl' }, {}, deps())).toThrow(/WSL/)
  })
})

describe('applyClientProfileEnvPlan', () => {
  it('mutates in place, appends git config after caller entries and fixes envToDelete', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ambient',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.interactive',
      GIT_CONFIG_VALUE_0: 'false'
    }
    const plan = planClientProfileEnv(acme(), { kind: 'local' }, env, deps())
    const envToDelete = applyClientProfileEnvPlan(env, ['GH_TOKEN', 'PI_OWNER'], plan, 'linux')
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_TOKEN).toBe('fixture-gh-value')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.interactive')
    expect(env.GIT_CONFIG_KEY_1).toBe('core.hooksPath')
    expect(Number(env.GIT_CONFIG_COUNT)).toBe(1 + plan.gitConfigEntries.length)
    expect(envToDelete).toContain('PI_OWNER')
    expect(envToDelete).toContain('GITHUB_TOKEN')
    expect(envToDelete).not.toContain('GH_TOKEN')
    expect(envToDelete.some((key) => key.startsWith('GIT_CONFIG_'))).toBe(false)
  })

  it('reuses the Windows `Path` key instead of adding a second PATH', () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }
    const plan = planClientProfileEnv(acme(), { kind: 'local' }, env, deps({ platform: 'win32' }))
    applyClientProfileEnvPlan(env, undefined, plan, 'win32')
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['Path'])
    expect(env.Path?.endsWith(';C:\\Windows')).toBe(true)
  })
})

describe('child env helpers', () => {
  it('folds the command-scope git config into `set` for the binding layer', () => {
    const result = buildClientProfileProcessEnv(acme(), { target: 'local', baseEnv: {} }, deps())
    expect(result.set.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
    expect(result.set.GIT_CONFIG_COUNT).toBeDefined()
    expect(result.delete).toContain('OPENAI_API_KEY')
  })

  it('returns a new env and never touches the base env or process.env', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', OPENAI_API_KEY: 'ambient' }
    const child = buildClientProfileChildEnv(base, acme(), { kind: 'local' }, deps())
    expect(child.OPENAI_API_KEY).toBeUndefined()
    expect(child.AIBORG_PROFILE_ID).toBe('acme')
    expect(base.OPENAI_API_KEY).toBe('ambient')
    expect(process.env.AIBORG_PROFILE_ID).toBeUndefined()
  })
})
