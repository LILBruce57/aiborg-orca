// Binding layer: spawn hooks (H20/H21/H48), Orca's own git (H27), structured env (H23/H31) and
// the account-home guard (H33). Placeholder clients only: acme and contoso.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAgentSessionPreSpawnError } from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  ACME,
  AMBIENT_PERSONAL_ENV,
  CONTOSO,
  FIXTURE_SECRETS,
  comparablePath,
  readJsonLines
} from '../guardrails/client-profile-test-fixtures'
import {
  createClientProfileSandbox,
  type ClientProfileSandbox
} from '../guardrails/client-profile-sandbox-test-fixture'
import {
  headlessSpawn,
  rendererSpawn,
  worktreeIdFor
} from '../guardrails/client-profile-spawn-test-harness'
import type { KeyringBackend } from '../keychain/client-profile-keychain'
import {
  initClientProfileRuntime,
  resetClientProfileRuntimeForTests,
  type ClientProfileRuntime
} from '../profiles/client-profile-runtime'
import { regenerateClientProfileHomes } from '../profiles/client-profile-lifecycle'
import { assertAccountHomeAllowed } from '../agents/account-home-guard'
import { withStructuredClientProfileEnv } from '../agents/profile-agent-env'
import { stripClientProfileInheritedEnv } from '../../../shared/aiborg/client-profile-inherited-env'
import { forgetCachedClientProfileSecrets } from './client-profile-core-access'
import { withClientProfileGitEnv } from './client-profile-process-env'
import { isClientProfileRefusalError } from './client-profile-refusal'
import {
  getPtyClientProfileBinding,
  installOrcadClientProfileResolver,
  registerClientProfileRepoLookup,
  resetClientProfileResolutionForTests
} from './client-profile-resolution'

vi.mock(
  'electron',
  async () => (await import('../guardrails/client-profile-electron-test-fixture')).electronModule
)

function memoryKeyring(): KeyringBackend {
  const entries = new Map<string, string>()
  return {
    createEntry: (service, account) => {
      const key = `${service}/${account}`
      return {
        getPassword: () => entries.get(key) ?? null,
        setPassword: (value) => {
          entries.set(key, value)
        },
        deletePassword: () => entries.delete(key)
      }
    }
  }
}

describe('client profile binding', () => {
  let sandbox: ClientProfileSandbox
  let rt: ClientProfileRuntime
  let wt: { acme: string; contoso: string; unbound: string }
  let repoPath: { acme: string; unbound: string }

  beforeEach(async () => {
    sandbox = createClientProfileSandbox()
    rt = initClientProfileRuntime({
      userDataPath: sandbox.userData,
      loadKeyringBackend: memoryKeyring
    })
    for (const id of [ACME, CONTOSO] as const) {
      for (const [name, value] of Object.entries(FIXTURE_SECRETS[id])) {
        rt.keychain.setSecret(id, name, value)
      }
    }
    repoPath = {
      acme: join(sandbox.root, 'work', 'acme-app'),
      unbound: join(sandbox.root, 'work', 'free')
    }
    const repos = [
      { id: 'repo-acme', path: repoPath.acme },
      { id: 'repo-contoso', path: join(sandbox.root, 'work', 'contoso-app') },
      { id: 'repo-unbound', path: repoPath.unbound }
    ]
    registerClientProfileRepoLookup(() => repos)
    rt.sidecar.setRepoBinding('repo-acme', ACME)
    rt.sidecar.setRepoBinding('repo-contoso', CONTOSO)
    rt.sidecar.setActiveProfileId(CONTOSO)
    wt = {
      acme: worktreeIdFor('repo-acme', repos[0].path),
      contoso: worktreeIdFor('repo-contoso', repos[1].path),
      unbound: worktreeIdFor('repo-unbound', repos[2].path)
    }
    await regenerateClientProfileHomes(rt)
  })

  afterEach(() => {
    resetClientProfileResolutionForTests()
    resetClientProfileRuntimeForTests()
    forgetCachedClientProfileSecrets()
    sandbox.dispose()
  })

  const acmeHome = (tool: string): string => join(sandbox.profileHome(ACME), tool)

  it('refuses a spawn while the generated git config and push guards are missing', async () => {
    rmSync(join(sandbox.profileHome(ACME), 'gitconfig'))
    const refusal = await headlessSpawn({ worktreeId: wt.acme, env: {} }).catch((e: unknown) => e)
    expect(isClientProfileRefusalError(refusal)).toBe(true)
    expect(String(refusal)).toContain('not set up yet')
  })

  it('refuses a renderer spawn of an acme repo under contoso and audits it', async () => {
    const refusal = await rendererSpawn({ worktreeId: wt.acme, env: {} }).catch((e: unknown) => e)
    expect(isClientProfileRefusalError(refusal)).toBe(true)
    const audit = readJsonLines(join(sandbox.profileHome(ACME), 'audit.jsonl'))
    expect(audit.map((line) => line.event)).toContain('terminal.refused')
  })

  it('runs a headless acme spawn with only acme values and the managed deletes', async () => {
    const result = await headlessSpawn({
      worktreeId: wt.acme,
      env: { ...AMBIENT_PERSONAL_ENV }
    })
    expect(result.env.AIBORG_PROFILE_ID).toBe(ACME)
    expect(result.env.GH_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
    expect(result.env.GITHUB_TOKEN).toBeUndefined()
    expect(result.env.OPENAI_API_KEY).toBeUndefined()
    expect(result.envToDelete).toContain('GITHUB_TOKEN')
    expect(result.envToDelete).not.toContain('GH_TOKEN')
    expect(result.ctxEnv).toBe(result.env)
    expect(comparablePath(result.env.CODEX_HOME)).toBe(comparablePath(acmeHome('codex')))
  })

  it('points the LocalPtyProvider Codex override at P/codex', async () => {
    rt.sidecar.setActiveProfileId(ACME)
    const result = await rendererSpawn({
      worktreeId: wt.acme,
      daemon: false,
      env: {}
    })
    expect(comparablePath(result.codexHomePathOverride?.value ?? '')).toBe(
      comparablePath(acmeHome('codex'))
    )
  })

  it('pins floating terminals and unbound repos to the active profile', async () => {
    expect((await rendererSpawn({ env: {} })).env.AIBORG_PROFILE_ID).toBe(CONTOSO)
    expect((await rendererSpawn({ worktreeId: wt.unbound, env: {} })).env.AIBORG_PROFILE_ID).toBe(
      CONTOSO
    )
  })

  it('keeps a live session on its pin, but re-resolves a cold restore from the worktree', async () => {
    rt.sidecar.setActiveProfileId(ACME)
    const sessionId = `${wt.acme}@@0a1b2c3d`
    await rendererSpawn({ worktreeId: wt.acme, sessionId, env: {} })
    expect(getPtyClientProfileBinding(sessionId)).toBe(ACME)
    rt.sidecar.setRepoBinding('repo-acme', CONTOSO)
    rt.sidecar.setActiveProfileId(CONTOSO)
    const reattached = await headlessSpawn({
      worktreeId: wt.acme,
      sessionId,
      env: {},
      liveSessionIds: [sessionId]
    })
    expect(reattached.env.AIBORG_PROFILE_ID).toBe(ACME)
    expect(getPtyClientProfileBinding(sessionId)).toBe(ACME)
    // The session is gone (reboot): the stale acme pin must not reach the contoso repo.
    const restored = await headlessSpawn({ worktreeId: wt.acme, sessionId, env: {} })
    expect(restored.env.AIBORG_PROFILE_ID).toBe(CONTOSO)
    expect(restored.env.GH_TOKEN).toBe(FIXTURE_SECRETS.contoso.GH_TOKEN)
    expect(getPtyClientProfileBinding(sessionId)).toBe(CONTOSO)
  })

  it('reattaches a live terminal of another profile instead of refusing it', async () => {
    rt.sidecar.setActiveProfileId(ACME)
    const sessionId = `${wt.acme}@@5e6f7a8b`
    await rendererSpawn({ worktreeId: wt.acme, sessionId, env: {} })
    rt.sidecar.setActiveProfileId(CONTOSO)
    const reattached = await rendererSpawn({
      worktreeId: wt.acme,
      sessionId,
      env: {},
      liveSessionIds: [sessionId]
    })
    expect(reattached.env.AIBORG_PROFILE_ID).toBe(ACME)
    expect(getPtyClientProfileBinding(sessionId)).toBe(ACME)
    await expect(rendererSpawn({ worktreeId: wt.acme, sessionId, env: {} })).rejects.toThrow()
  })

  it('refuses SSH without remote.allow, WSL always, and a foreign Codex resume home', async () => {
    await expect(
      headlessSpawn({ worktreeId: wt.acme, connectionId: 'ssh-1', env: {} })
    ).rejects.toThrow()
    await expect(
      headlessSpawn({ worktreeId: wt.acme, wslDistro: 'Ubuntu', env: {} })
    ).rejects.toThrow()
    rt.sidecar.setActiveProfileId(ACME)
    await expect(
      rendererSpawn({
        worktreeId: wt.acme,
        daemon: false,
        env: {},
        codexResumeHome: join(sandbox.home, '.codex')
      })
    ).rejects.toThrow()
  })

  it('changes nothing in personal mode', async () => {
    rt.sidecar.setRepoBinding('repo-acme', null)
    rt.sidecar.setRepoBinding('repo-contoso', null)
    rt.sidecar.setActiveProfileId(null)
    const result = await headlessSpawn({
      worktreeId: wt.unbound,
      env: { GITHUB_TOKEN: 'mine' }
    })
    expect(result.env.AIBORG_PROFILE_ID).toBeUndefined()
    expect(result.env.GITHUB_TOKEN).toBe('mine')
    expect(withClientProfileGitEnv(undefined, { cwd: repoPath.unbound })).toBeUndefined()
  })

  it('orcad refuses profile-bound spawns', async () => {
    installOrcadClientProfileResolver()
    await expect(headlessSpawn({ worktreeId: wt.acme, env: {} })).rejects.toThrow()
  })

  it("gives Orca's own git the cwd's profile and leaves unknown paths alone", () => {
    const env = withClientProfileGitEnv(undefined, {
      cwd: join(repoPath.acme, 'src')
    })
    expect(env?.AIBORG_PROFILE_ID).toBe(ACME)
    expect(comparablePath(env?.GIT_CONFIG_GLOBAL ?? '')).toBe(comparablePath(acmeHome('gitconfig')))
    expect(Number(env?.GIT_CONFIG_COUNT)).toBeGreaterThan(0)
    expect(env?.GITHUB_TOKEN).toBeUndefined()
    const personal = { PATH: '/usr/bin' }
    expect(
      withClientProfileGitEnv(personal, {
        cwd: join(sandbox.root, 'elsewhere')
      })
    ).toBe(personal)
  })

  it('strips ambient credentials from structured children, including the inherited layer', () => {
    const record = {
      location: { workspaceId: wt.acme },
      accountHome: { path: acmeHome('claude') }
    }
    const launchEnv = withStructuredClientProfileEnv(record, 'claude', {
      ...AMBIENT_PERSONAL_ENV,
      PATH: '/usr/bin'
    })
    expect(launchEnv.GH_TOKEN).toBe(FIXTURE_SECRETS.acme.GH_TOKEN)
    expect(launchEnv.OPENAI_API_KEY).toBeUndefined()
    expect(comparablePath(launchEnv.CLAUDE_CONFIG_DIR)).toBe(comparablePath(acmeHome('claude')))
    const inherited = stripClientProfileInheritedEnv({ ...AMBIENT_PERSONAL_ENV }, launchEnv)
    expect(inherited.GITHUB_TOKEN).toBeUndefined()
    expect(inherited.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(stripClientProfileInheritedEnv({ GITHUB_TOKEN: 'x' }, { PATH: '/usr/bin' })).toEqual({
      GITHUB_TOKEN: 'x'
    })
  })

  it('guards structured account homes (invariant 4)', () => {
    const refusal = (accountHomePath: string, workspaceId: string): unknown => {
      try {
        assertAccountHomeAllowed({
          provider: 'claude',
          workspaceId,
          accountHomePath
        })
        return null
      } catch (error) {
        return error
      }
    }
    expect(refusal(acmeHome('claude'), wt.acme)).toBeNull()
    expect(isAgentSessionPreSpawnError(refusal(acmeHome('claude'), wt.contoso))).toBe(true)
    expect(isAgentSessionPreSpawnError(refusal(join(sandbox.home, '.claude'), wt.acme))).toBe(true)
    rt.sidecar.setActiveProfileId(null)
    expect(refusal(join(sandbox.home, '.claude'), wt.unbound)).toBeNull()
    expect(isAgentSessionPreSpawnError(refusal(acmeHome('claude'), wt.unbound))).toBe(true)
  })
})
