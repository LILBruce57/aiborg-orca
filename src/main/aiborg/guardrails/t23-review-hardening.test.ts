// Review hardening: delete flow (macOS Claude item, structured sessions, keychain names), secret
// caches, Codex children in profile homes, WSL UNC cwds, GHES tokens and az's broker.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteClientProfile } from '../profiles/client-profile-lifecycle'
import { getClientProfileRuntime } from '../profiles/client-profile-runtime'
import { ClientProfileSidecarStore } from '../profiles/client-profile-sidecar'
import {
  resetClientProfileStructuredChildrenForTests,
  trackClientProfileStructuredChild
} from '../agents/client-profile-structured-children'
import {
  clientProfileCodexTrustGrantEnv,
  withClientProfileCodexHomeEnv
} from '../agents/client-profile-usage'
import { withClientProfileGitEnv } from '../binding/client-profile-process-env'
import type * as ClaudeKeychainModule from '../agents/client-profile-claude-keychain'
import { ACME, CONTOSO, FIXTURE_SECRETS, acmeProfileJson } from './client-profile-test-fixtures'
import { clientProfiles } from './client-profile-test-harness'
import { headlessSpawn } from './client-profile-spawn-test-harness'
import {
  createClientProfileWorld,
  type ClientProfileWorld
} from './client-profile-world-test-harness'

const { claudeKeychainDeletes } = vi.hoisted(() => {
  const deletes: string[] = []
  return { claudeKeychainDeletes: deletes }
})

vi.mock(
  'electron',
  async () => (await import('./client-profile-electron-test-fixture')).electronModule
)
vi.mock(
  '@napi-rs/keyring',
  async () => (await import('./client-profile-keyring-test-fixture')).keyringModule
)
vi.mock('../agents/client-profile-claude-keychain', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeKeychainModule>()
  return {
    ...actual,
    deleteClientProfileClaudeCredentials: vi.fn(async (dir: string) => {
      claudeKeychainDeletes.push(dir)
    })
  }
})

describe('T23 delete flow and caches', () => {
  let world: ClientProfileWorld

  beforeEach(async () => {
    claudeKeychainDeletes.length = 0
    resetClientProfileStructuredChildrenForTests()
    world = await createClientProfileWorld({ active: CONTOSO })
  })

  afterEach(async () => world.dispose())

  const rt = () => {
    const runtime = getClientProfileRuntime()
    if (!runtime) {
      throw new Error('client profiles are not initialised')
    }
    return runtime
  }

  it('removes the Claude keychain item derived from P/claude on delete', async () => {
    await expect(
      deleteClientProfile({ profileId: ACME, confirmId: ACME, deleteJson: false }, rt())
    ).resolves.toEqual({ ok: true })
    expect(claudeKeychainDeletes).toEqual([join(world.profileHome(ACME), 'claude')])
  })

  it('waits for a running structured session of the profile before deleting', async () => {
    const child = new EventEmitter()
    trackClientProfileStructuredChild({ AIBORG_PROFILE_ID: ACME }, child)
    await expect(
      deleteClientProfile({ profileId: ACME, confirmId: ACME, deleteJson: false }, rt())
    ).resolves.toMatchObject({ ok: false, reason: 'in-use' })
    child.emit('exit', 0)
    child.emit('close', 0)
    await expect(
      deleteClientProfile({ profileId: ACME, confirmId: ACME, deleteJson: false }, rt())
    ).resolves.toEqual({ ok: true })
  })

  it('wipes keychain entries named by the profile JSON even when the sidecar lost them', async () => {
    rt().sidecar.update((draft) => {
      draft.storedSecretNames = {}
    })
    await deleteClientProfile({ profileId: ACME, confirmId: ACME, deleteJson: false }, rt())
    for (const name of Object.keys(FIXTURE_SECRETS.acme)) {
      expect(await clientProfiles.keychain.getSecret(ACME, name)).toBeNull()
    }
  })

  it('stops injecting a deleted secret at once (no stale cache)', async () => {
    const first = await headlessSpawn({ worktreeId: world.worktreeIds.acme, env: {} })
    expect(first.env.GH_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
    await clientProfiles.keychain.deleteSecret(ACME, 'GH_TOKEN')
    const second = await headlessSpawn({ worktreeId: world.worktreeIds.acme, env: {} })
    expect(second.env.GH_TOKEN).toBeUndefined()
    await clientProfiles.keychain.setSecret(ACME, 'GH_TOKEN', 'fixture-acme-gh-rotated')
    const third = await headlessSpawn({ worktreeId: world.worktreeIds.acme, env: {} })
    expect(third.env.GH_TOKEN).toBe('fixture-acme-gh-rotated')
  })
})

describe('T23 children in profile homes', () => {
  let world: ClientProfileWorld

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: ACME })
  })

  afterEach(async () => world.dispose())

  it('gives a codex app-server in P/codex the profile env, not main personal keys', () => {
    const acmeCodex = join(world.profileHome(ACME), 'codex')
    const env = withClientProfileCodexHomeEnv(acmeCodex, { ...process.env, CODEX_HOME: acmeCodex })
    expect(env.AIBORG_PROFILE_ID).toBe(ACME)
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
    const elsewhere = { ...process.env, CODEX_HOME: join(world.sandbox.home, '.codex') }
    expect(withClientProfileCodexHomeEnv(join(world.sandbox.home, '.codex'), elsewhere)).toBe(
      elsewhere
    )
  })

  it('runs a trust grant in P/codex under the profile env and refuses one outside profile homes', () => {
    const acmeCodex = join(world.profileHome(ACME), 'codex')
    const env = clientProfileCodexTrustGrantEnv({ env: { CODEX_HOME: acmeCodex } })
    expect(env?.AIBORG_PROFILE_ID).toBe(ACME)
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env?.AIBORG_PROFILE_UNSET).toContain('OPENAI_API_KEY')
    expect(() =>
      clientProfileCodexTrustGrantEnv({ env: { CODEX_HOME: join(world.sandbox.home, '.codex') } })
    ).toThrow(/AI-Borg/)
  })

  it('refuses profile-bound git whose cwd is a \\\\wsl.localhost path', async () => {
    const unc = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\acme-app'
    clientProfiles.registerRepos([world.repos.acme, { id: 'repo-wsl', path: unc }])
    await clientProfiles.bindRepo('repo-wsl', ACME)
    expect(() => withClientProfileGitEnv({}, { cwd: unc })).toThrow(/WSL/)
    await clientProfiles.bindRepo('repo-wsl', null)
    await clientProfiles.activate(null)
    const env = {}
    expect(withClientProfileGitEnv(env, { cwd: unc })).toBe(env)
  })
})

describe('T23 GHES token and az broker', () => {
  let world: ClientProfileWorld

  afterEach(async () => world.dispose())

  it('sets GH_ENTERPRISE_TOKEN for a GHES profile and keeps az in AZURE_CONFIG_DIR', async () => {
    world = await createClientProfileWorld({ active: ACME })
    world.sandbox.writeProfile(
      acmeProfileJson({
        github: { host: 'github.acme.example', allowedOrgs: ['acme-inc'], login: 'example' }
      })
    )
    const runtime = getClientProfileRuntime()
    runtime?.store.reload()
    const { env, envToDelete } = await headlessSpawn({
      worktreeId: world.worktreeIds.acme,
      env: { GH_ENTERPRISE_TOKEN: 'ambient-personal-ghes' }
    })
    expect(env.GH_ENTERPRISE_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
    expect(env.AZURE_CORE_ENABLE_BROKER_ON_WINDOWS).toBe('false')
    const contoso = await headlessSpawn({
      worktreeId: world.worktreeIds.contoso,
      env: { GH_ENTERPRISE_TOKEN: 'ambient-personal-ghes' }
    })
    expect(contoso.env.GH_ENTERPRISE_TOKEN).toBeUndefined()
    expect(contoso.envToDelete).toEqual(expect.arrayContaining(['GH_ENTERPRISE_TOKEN']))
    expect(envToDelete).toEqual(expect.arrayContaining(['GITHUB_ENTERPRISE_TOKEN']))
  })
})

describe('T23 Claude keychain cleanup', () => {
  it('deletes only on macOS, through the scoped deleter', async () => {
    const { deleteClientProfileClaudeCredentials: real } = await vi.importActual<
      typeof ClaudeKeychainModule
    >('../agents/client-profile-claude-keychain')
    const deleteScoped = vi.fn(async () => {})
    await real('/p/acme/claude', { platform: 'win32', deleteScoped })
    expect(deleteScoped).not.toHaveBeenCalled()
    await real('/p/acme/claude', { platform: 'darwin', deleteScoped })
    expect(deleteScoped).toHaveBeenCalledWith('/p/acme/claude')
  })
})

describe('T23 unwritable sidecar', () => {
  it('never fails a terminal open or close when the sidecar cannot be written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiborg-sidecar-'))
    try {
      // A directory where the file should be: every write fails (EISDIR / EPERM).
      const blocked = join(dir, 'aiborg-client-profiles.json')
      mkdirSync(blocked)
      const sidecar = new ClientProfileSidecarStore(blocked)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(() => sidecar.setPtyBinding('pty-1', ACME)).not.toThrow()
      expect(sidecar.read().ptyBindings['pty-1']).toBe(ACME)
      expect(() => sidecar.setPtyBinding('pty-1', null)).not.toThrow()
      expect(() => sidecar.flush()).not.toThrow()
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('T23 sidecar terminal bindings', () => {
  let world: ClientProfileWorld

  afterEach(async () => world.dispose())

  it('records bindings in memory at once and writes the file debounced', async () => {
    world = await createClientProfileWorld({ active: ACME })
    const runtime = getClientProfileRuntime()
    runtime?.sidecar.setPtyBinding('pty-debounced', ACME)
    expect(runtime?.sidecar.read().ptyBindings['pty-debounced']).toBe(ACME)
    expect(readFileSync(world.sandbox.sidecarPath(), 'utf8')).not.toContain('pty-debounced')
    runtime?.sidecar.flush()
    expect(readFileSync(world.sandbox.sidecarPath(), 'utf8')).toContain('pty-debounced')
  })
})
