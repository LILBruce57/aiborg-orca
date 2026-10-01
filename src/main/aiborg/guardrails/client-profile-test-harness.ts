// The guardrail suite's only seam into the Phase 2/3 implementation.
// The tests were written from docs/aiborg/CLIENT-PROFILES-DESIGN.md before the code existed.
// When an implementation name or signature differs, adapt the bindings below, not the tests.
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  ClientProfile,
  ClientProfileAuditEvent
} from '../../../shared/aiborg/client-profile-types'
import type { ClaudeStructuredLaunchResolverDeps } from '../../claude/claude-structured-launch-resolution'
import {
  validateClientProfile,
  validateClientProfileSet
} from '../../../shared/aiborg/client-profile-schema'
import { buildClientProfileEnv } from '../env/client-profile-env'
import { withClientProfileEnv } from '../binding/client-profile-process-env'
import { installClientProfileMainHooks } from '../binding/client-profile-wiring'
import {
  activateClientProfile,
  bindRepoToClientProfile,
  initClientProfilesForMain,
  resetClientProfilesForTests
} from '../ipc/client-profile-ipc'
import {
  getPtyClientProfileBinding,
  installOrcadClientProfileResolver,
  registerClientProfileRepoLookup,
  resolveRepoClientProfileId
} from '../binding/client-profile-resolution'
import * as keychainModule from '../keychain/client-profile-keychain'
import { assertAccountHomeAllowed } from '../agents/account-home-guard'
import { profileAgentEnv } from '../agents/profile-agent-env'
import {
  appendClientProfileAudit,
  type ClientProfileAuditFieldValue
} from '../audit/client-profile-audit'
import { isGitVersionSupportedForClientProfiles } from '../profiles/client-profile-dirs'
import { regenerateClientProfileHomes } from '../profiles/client-profile-lifecycle'

export type { ClientProfile }

export type ValidationResult =
  | { ok: true; profile: ClientProfile }
  | { ok: false; errors: string[] }

export type EnvTarget =
  | { kind: 'local' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'wsl'; distro: string }

export type EnvBuildContext = {
  platform: NodeJS.Platform
  /** Every loaded profile; their env/secret keys join the managed delete set (§3.2). */
  allProfiles: readonly ClientProfile[]
  /** The PATH value `P/bin` is prepended to. */
  basePath: string
  machine?: { sshAuthSock?: string | null; windowsSsh?: string | null }
}

export type BuiltProfileEnv = { set: Record<string, string>; delete: string[] }

export type SecretStatus = Record<string, 'set' | 'missing'>

export type KnownRepo = {
  id: string
  path: string
  connectionId?: string | null
}

export const clientProfiles = {
  validateProfile(raw: unknown, fileName: string): ValidationResult {
    return validateClientProfile(raw, fileName)
  },

  /** Cross-profile checks (duplicate allowedOrgs); empty when the set is valid. */
  validateProfileSet(profiles: readonly ClientProfile[]): string[] {
    return validateClientProfileSet(profiles)
  },

  /** Validated profile or a thrown error; keeps fixtures free of casts. */
  profileFrom(raw: unknown, fileName?: string): ClientProfile {
    const id = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : 'unknown'
    const result = validateClientProfile(raw, fileName ?? `${id}.json`)
    if (!result.ok) {
      throw new Error(`fixture profile ${id} is invalid: ${result.errors.join('; ')}`)
    }
    return result.profile
  },

  buildEnv(
    profile: ClientProfile,
    secrets: Record<string, string>,
    target: EnvTarget,
    context: EnvBuildContext
  ): BuiltProfileEnv {
    return buildClientProfileEnv(profile, secrets, { ...target, ...context })
  },

  /** Loads the sidecar and profilesDir from AIBORG_PROFILES_DIR / userData, installs the H22 resolver. */
  async init(): Promise<void> {
    // Production startup (H22) minus the repo source, which registerRepos provides.
    installClientProfileMainHooks()
    const rt = initClientProfilesForMain()
    // Why: production picks up profile file edits through the store watcher, which is async.
    rt.store.reload()
    await rt.keychainReady
    // Production regenerates P/* at startup too; awaited here so spawns never race it.
    await regenerateClientProfileHomes(rt)
  },

  /** Drops module state (resolver, caches, watchers) so the next test starts clean. */
  async reset(): Promise<void> {
    await Promise.resolve(resetClientProfilesForTests())
  },

  /** Activation through the main-owned path; rewrites gitconfig, hooks and P/bin (§3.3). */
  async activate(profileId: string | null): Promise<void> {
    await Promise.resolve(activateClientProfile(profileId))
  },

  async bindRepo(repoId: string, profileId: string | null): Promise<void> {
    await Promise.resolve(bindRepoToClientProfile(repoId, profileId))
  },

  /** Known repos for cwd → repo resolution (H27/H50); production reads them from the store. */
  registerRepos(repos: readonly KnownRepo[]): void {
    registerClientProfileRepoLookup(() => repos)
  },

  /** orcad has no keychain: profile-bound spawns must be refused there (H22). */
  useOrcadResolver(): void {
    installOrcadClientProfileResolver()
  },

  /** §1.2 repo matching: sidecar binding, else the owner of `origin`'s push URL. */
  async profileForRepo(repo: KnownRepo): Promise<string | null> {
    return (await Promise.resolve(resolveRepoClientProfileId(repo))) ?? null
  },

  ptyBinding(ptyOrSessionId: string): string | null {
    return getPtyClientProfileBinding(ptyOrSessionId) ?? null
  },

  // Async wrappers: sync or async implementations, and sync throws, all surface as promises.
  keychain: {
    getSecret: async (profileId: string, name: string): Promise<string | null> =>
      (await Promise.resolve(keychainModule.getSecret(profileId, name))) ?? null,
    setSecret: async (profileId: string, name: string, value: string): Promise<void> => {
      await Promise.resolve(keychainModule.setSecret(profileId, name, value))
    },
    deleteSecret: async (profileId: string, name: string): Promise<void> => {
      await Promise.resolve(keychainModule.deleteSecret(profileId, name))
    },
    deleteAll: async (profileId: string): Promise<void> => {
      await Promise.resolve(keychainModule.deleteAll(profileId))
    },
    status: async (profileId: string): Promise<SecretStatus> =>
      Object.fromEntries(
        Object.entries(await Promise.resolve(keychainModule.status(profileId))).map(
          ([name, state]) => [name, state === 'set' ? 'set' : 'missing']
        )
      )
  },

  /** Throws AgentSessionPreSpawnError when `accountHomePath` is not the workspace profile's home. */
  assertAccountHome(input: {
    provider: 'claude' | 'codex'
    workspaceId: string
    accountHomePath: string
  }): void {
    assertAccountHomeAllowed(input)
  },

  /** The H33 dep the production wiring passes to createClaudeStructuredLaunchResolver. */
  claudeResolverGuardDeps(): Pick<ClaudeStructuredLaunchResolverDeps, 'assertAccountHomeAllowed'> {
    return {
      assertAccountHomeAllowed: (record: AgentSessionRecord) =>
        assertAccountHomeAllowed({
          provider: 'claude',
          workspaceId: record.location.workspaceId,
          accountHomePath: record.accountHome.path
        })
    }
  },

  /** The env a structured session for `workspaceId` is created with (H30). */
  agentEnv(workspaceId: string): {
    env: Record<string, string>
    envToDelete: string[]
  } {
    return profileAgentEnv({ workspaceId })
  },

  /** Env for orca.yaml scripts, text generation and notebook kernels (H25/H26/H49); throws when refused. */
  scriptEnv(input: {
    cwd: string
    worktreeId?: string
    wslDistro?: string | null
    baseEnv: NodeJS.ProcessEnv
  }): NodeJS.ProcessEnv {
    return withClientProfileEnv(input.baseEnv, input)
  },

  audit(
    profileId: string,
    event: ClientProfileAuditEvent,
    fields: Record<string, ClientProfileAuditFieldValue> = {}
  ): void {
    appendClientProfileAudit(profileId, event, fields)
  },

  gitVersionSupported(version: string): boolean {
    return isGitVersionSupportedForClientProfiles(version)
  }
}
