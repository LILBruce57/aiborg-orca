import type {
  ClientProfile,
  ClientProfileSpawnTarget
} from '../../../shared/aiborg/client-profile-types'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { applyClientProfileEnvPlan } from '../env/apply-client-profile-env'
import type { ClientProfileEnvPlan } from '../env/client-profile-env'
import type { ClientProfileHomeLayout } from '../profiles/client-profile-paths'
import { hasClientProfileGuardFiles } from '../profiles/client-profile-dirs'
import {
  auditClientProfile,
  getClientProfileLayout,
  planClientProfileProcessEnv
} from './client-profile-core-access'
import { ClientProfileRefusalError } from './client-profile-refusal'
import { assertGhCommandWriteAllowed } from '../git/client-profile-gh-write-guard'
import {
  isClientProfileRefusingHost,
  listCwdRemoteOwners,
  resolveActiveClientProfile,
  resolveCwdClientProfile,
  type ClientProfileResolution
} from './client-profile-resolution'

export type ClientProfileEnvApplication = {
  profile: ClientProfile
  layout: ClientProfileHomeLayout
  plan: ClientProfileEnvPlan
}

type EnvRecord = NodeJS.ProcessEnv

const REFUSAL_AUDIT_INTERVAL_MS = 60_000
const lastRefusalAudit = new Map<string, number>()

// Why throttle: git status polling of a refused repo would otherwise write a line per poll.
function auditRefusal(profileId: string, action: string, reason: string): void {
  const key = `${profileId}|${action}|${reason}`
  const now = Date.now()
  if (now - (lastRefusalAudit.get(key) ?? 0) < REFUSAL_AUDIT_INTERVAL_MS) {
    return
  }
  lastRefusalAudit.set(key, now)
  auditClientProfile(profileId, 'terminal.refused', { action, reason })
}

/**
 * The env plan a child under the resolved profile must carry, or null in personal mode. Throws
 * whenever the profile cannot be applied correctly (fail closed, invariant 7).
 */
export function buildClientProfileEnvApplication(
  resolved: ClientProfileResolution,
  options: {
    target: ClientProfileSpawnTarget
    baseEnv: EnvRecord
    action: string
  }
): ClientProfileEnvApplication | null {
  const { profileId } = resolved
  if (!profileId) {
    return null
  }
  const refuse = (code: ClientProfileRefusalError['code'], message: string): never => {
    auditRefusal(profileId, options.action, code)
    throw new ClientProfileRefusalError(code, profileId, message)
  }
  if (isClientProfileRefusingHost()) {
    refuse(
      'orcad-unsupported',
      `AI-Borg: client profile "${profileId}" cannot be applied by the headless server (no keychain access).`
    )
  }
  const conflicts = resolved.conflictingProfileIds ?? []
  const profile =
    resolved.profile ??
    refuse(
      'profile-unavailable',
      conflicts.length > 0
        ? `AI-Borg: this repo's remotes belong to several client profiles (${[profileId, ...conflicts].join(', ')}), so nothing runs for it. Bind the repo to one profile.`
        : `AI-Borg: client profile "${profileId}" is missing or invalid, so nothing runs for it.`
    )
  if (options.target.kind === 'wsl') {
    refuse('wsl-unsupported', `AI-Borg: client profile ${profile.name} does not support WSL yet.`)
  }
  if (options.target.kind === 'ssh' && !profile.remote?.allow) {
    refuse(
      'ssh-not-allowed',
      `AI-Borg: client profile ${profile.name} does not allow SSH targets (remote.allow is off).`
    )
  }
  const layout = getClientProfileLayout(profile.id)
  if (options.target.kind === 'local' && !hasClientProfileGuardFiles(layout)) {
    refuse(
      'env-unavailable',
      `AI-Borg: client profile ${profile.name} is not set up yet (its generated git config and push guards are missing). Activate it once, then try again.`
    )
  }
  try {
    const plan = planClientProfileProcessEnv(profile, options.target, options.baseEnv)
    return { profile, layout, plan }
  } catch (error) {
    const reason =
      error instanceof Error && 'reason' in error ? String(error.reason) : 'env-unavailable'
    auditRefusal(profileId, options.action, reason)
    throw error
  }
}

/** Mutates `env` (deletes, values, command-scope git config) and returns the new delete list. */
export function applyClientProfileEnvApplication(
  env: EnvRecord,
  application: ClientProfileEnvApplication,
  envToDelete?: readonly string[],
  extraDeletes: readonly string[] = []
): string[] {
  const merged = applyClientProfileEnvPlan(env, envToDelete, application.plan, process.platform)
  const setKeys = new Set(Object.keys(application.plan.set).map((key) => key.toUpperCase()))
  return [
    ...merged,
    ...extraDeletes.filter((key) => !setKeys.has(key.toUpperCase()) && !merged.includes(key))
  ]
}

function targetFor(wsl: boolean): ClientProfileSpawnTarget {
  return wsl ? { kind: 'wsl' } : { kind: 'local' }
}

/** WSL by distro or by a `\\wsl.localhost\...` cwd, which git and gh route through wsl.exe. */
function isWslTarget(options: { cwd?: string | null; wslDistro?: string | null }): boolean {
  return Boolean(options.wslDistro) || Boolean(options.cwd && isWslUncPath(options.cwd))
}

function withApplication(
  env: EnvRecord | undefined,
  resolved: ClientProfileResolution,
  wsl: boolean,
  action: string
): EnvRecord | undefined {
  if (!resolved.profileId) {
    return env
  }
  const next: EnvRecord = { ...(env ?? process.env) }
  const application = buildClientProfileEnvApplication(resolved, {
    target: targetFor(wsl),
    baseEnv: next,
    action
  })
  if (application) {
    applyClientProfileEnvApplication(next, application)
  }
  return next
}

/** H27/H28/H47: Orca's own git under the cwd's profile; unknown cwd and personal mode pass through. */
export function withClientProfileGitEnv(
  env: EnvRecord | undefined,
  options: { cwd?: string; wslDistro?: string }
): EnvRecord | undefined {
  return withApplication(env, resolveCwdClientProfile(options.cwd), isWslTarget(options), 'git')
}

/**
 * H29: Orca's own gh. Calls with no known repo (viewer/global queries) use the active profile.
 * With `args`, a write outside the profile's allowedOrgs is refused before gh runs (H54).
 */
export function withClientProfileGhEnv(
  env: EnvRecord | undefined,
  options: { cwd?: string; wslDistro?: string },
  args?: readonly string[]
): EnvRecord | undefined {
  const byCwd = resolveCwdClientProfile(options.cwd)
  const resolved = byCwd.profileId || byCwd.repoId ? byCwd : resolveActiveClientProfile()
  const next = withApplication(env, resolved, isWslTarget(options), 'gh')
  if (args && resolved.profileId) {
    assertGhCommandWriteAllowed(args, options.cwd, listCwdRemoteOwners)
  }
  return next
}

/** H25/H49: scripts and agents Orca runs in a worktree (text generation, notebook kernels). */
export function withClientProfileEnv(
  env: EnvRecord | undefined,
  options: {
    cwd: string | undefined
    wslDistro?: string | null
    action?: string
  }
): EnvRecord {
  return (
    withApplication(
      env,
      resolveCwdClientProfile(options.cwd),
      isWslTarget(options),
      options.action ?? 'script'
    ) ??
    env ??
    process.env
  )
}

export type ClientProfileHookEnv =
  | { ok: true; apply: (env: EnvRecord) => EnvRecord }
  | { ok: false; message: string }

/** H26: orca.yaml scripts report a refusal as a failed hook instead of throwing mid-flow. */
export function prepareClientProfileHookEnv(cwd: string, wsl: boolean): ClientProfileHookEnv {
  try {
    const application = buildClientProfileEnvApplication(resolveCwdClientProfile(cwd), {
      target: targetFor(wsl || isWslTarget({ cwd })),
      baseEnv: process.env,
      action: 'orca.yaml'
    })
    return {
      ok: true,
      apply: (env) => {
        if (!application) {
          return env
        }
        const next = { ...env }
        applyClientProfileEnvApplication(next, application)
        return next
      }
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/** H25: WSL text generation is refused for profile-bound repos (v1). */
export function assertClientProfileAllowsWsl(cwd: string | undefined, action: string): void {
  buildClientProfileEnvApplication(resolveCwdClientProfile(cwd), {
    target: { kind: 'wsl' },
    baseEnv: process.env,
    action
  })
}
