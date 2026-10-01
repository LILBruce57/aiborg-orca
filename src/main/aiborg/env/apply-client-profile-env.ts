import {
  appendGitConfigEnv,
  readValidGitConfigEnvCount
} from '../../../shared/git-credential-prompt-env'
import type {
  ClientProfile,
  ClientProfileMachineSettings,
  ClientProfileSpawnTarget
} from '../../../shared/aiborg/client-profile-types'
import { resolvePathEnvKey } from '../../pty/windows-path-segment-merge'
import { ClientProfileKeychainUnavailableError } from '../keychain/client-profile-keychain'
import { ClientProfileRefusalError } from '../binding/client-profile-refusal'
import {
  getClientProfileRuntime,
  type ClientProfileRuntime
} from '../profiles/client-profile-runtime'
import { buildClientProfileEnv, type ClientProfileEnvPlan } from './client-profile-env'

const GIT_CONFIG_PROTOCOL_KEY_RE = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/

/** The I/O side of the env builder: keychain reads and machine state. */
export type ClientProfileEnvDeps = {
  root: string
  machine: ClientProfileMachineSettings
  platform: NodeJS.Platform
  extraManagedKeys: readonly string[]
  readSecret: (profileId: string, name: string) => string | null
  systemEnv: NodeJS.ProcessEnv
  /** orcad has no keychain: every profile-bound spawn there is refused (H22). */
  refuseAllProfiles?: boolean
}

export function clientProfileEnvDepsFromRuntime(rt: ClientProfileRuntime): ClientProfileEnvDeps {
  return {
    root: rt.root,
    machine: rt.sidecar.read().machine,
    platform: process.platform,
    extraManagedKeys: rt.store.managedKeyUnion(),
    readSecret: (profileId, name) => rt.keychain.getSecret(profileId, name),
    systemEnv: rt.env,
    refuseAllProfiles: rt.mode === 'orcad'
  }
}

function resolveDeps(
  profile: ClientProfile,
  deps: ClientProfileEnvDeps | undefined
): ClientProfileEnvDeps {
  if (deps) {
    return deps
  }
  const rt = getClientProfileRuntime()
  if (!rt) {
    throw new ClientProfileRefusalError(
      'profile-unavailable',
      profile.id,
      'AI-Borg: client profiles are not initialised in this process.'
    )
  }
  return clientProfileEnvDepsFromRuntime(rt)
}

function findEnvKey(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== 'win32') {
    return key in env ? key : undefined
  }
  return Object.keys(env).find((candidate) => candidate.toUpperCase() === key.toUpperCase())
}

function envUnavailable(profile: ClientProfile, detail: string): ClientProfileRefusalError {
  return new ClientProfileRefusalError(
    'env-unavailable',
    profile.id,
    `AI-Borg: client profile ${profile.name} cannot be applied: ${detail}.`
  )
}

/** Reads the keychain and builds the plan; refuses (fail closed) instead of degrading. */
export function planClientProfileEnv(
  profile: ClientProfile,
  target: ClientProfileSpawnTarget,
  incomingEnv: NodeJS.ProcessEnv,
  depsOverride?: ClientProfileEnvDeps
): ClientProfileEnvPlan {
  const deps = resolveDeps(profile, depsOverride)
  if (deps.refuseAllProfiles) {
    throw new ClientProfileRefusalError(
      'orcad-unsupported',
      profile.id,
      `AI-Borg: client profile ${profile.name} cannot be applied by the headless server (no keychain access).`
    )
  }
  const secrets: Record<string, string> = {}
  if (target.kind === 'local') {
    try {
      for (const name of Object.keys(profile.secrets ?? {})) {
        const value = deps.readSecret(profile.id, name)
        if (value) {
          secrets[name] = value
        }
      }
    } catch (error) {
      if (error instanceof ClientProfileKeychainUnavailableError) {
        throw envUnavailable(profile, 'the OS keychain is unavailable')
      }
      throw error
    }
  }
  // Why the user's PATH as fallback: spawn envs are usually overlays the host merges over its own
  // env, and P/bin alone would hide every tool. The key keeps the host's spelling (Windows `Path`).
  const incomingPathKey = findEnvKey(incomingEnv, 'PATH', deps.platform)
  const systemPathKey = findEnvKey(deps.systemEnv, 'PATH', deps.platform)
  const basePath = incomingPathKey
    ? incomingEnv[incomingPathKey]
    : systemPathKey
      ? deps.systemEnv[systemPathKey]
      : undefined
  const plan = buildClientProfileEnv(profile, secrets, {
    kind: target.kind,
    platform: deps.platform,
    root: deps.root,
    machine: deps.machine,
    extraManagedKeys: deps.extraManagedKeys,
    basePath,
    systemEnv: deps.systemEnv
  })
  const pathKey = resolvePathEnvKey(incomingEnv, deps.platform, deps.systemEnv)
  if (plan.set.PATH !== undefined && pathKey !== 'PATH') {
    plan.set[pathKey] = plan.set.PATH
    delete plan.set.PATH
  }
  // Why refuse: appendGitConfigEnv silently appends nothing to an invalid count (no push guards).
  if (plan.gitConfigEntries.length > 0 && readValidGitConfigEnvCount(incomingEnv) === null) {
    throw envUnavailable(profile, 'the incoming GIT_CONFIG_COUNT is invalid')
  }
  return plan
}

/** `set` with the command-scope git config folded in as GIT_CONFIG_* values for this env. */
export function buildClientProfileProcessEnv(
  profile: ClientProfile,
  options: { target: ClientProfileSpawnTarget['kind']; baseEnv: NodeJS.ProcessEnv },
  depsOverride?: ClientProfileEnvDeps
): { set: Record<string, string>; delete: string[] } {
  const target: ClientProfileSpawnTarget =
    options.target === 'ssh' ? { kind: 'ssh', connectionId: '' } : { kind: options.target }
  const plan = planClientProfileEnv(profile, target, options.baseEnv, depsOverride)
  const set = { ...plan.set }
  if (plan.gitConfigEntries.length > 0) {
    const appended = appendGitConfigEnv(options.baseEnv, plan.gitConfigEntries)
    for (const key of Object.keys(appended).filter((k) => GIT_CONFIG_PROTOCOL_KEY_RE.test(k))) {
      const value = appended[key]
      if (value !== undefined && value !== options.baseEnv[key]) {
        set[key] = value
      }
    }
  }
  return { set, delete: plan.delete }
}

/** Mutates `env` in place (H21 aliases it) and returns the merged envToDelete list. */
export function applyClientProfileEnvPlan(
  env: NodeJS.ProcessEnv,
  envToDelete: readonly string[] | undefined,
  plan: ClientProfileEnvPlan,
  platform: NodeJS.Platform
): string[] {
  for (const key of plan.delete) {
    const existing = findEnvKey(env, key, platform)
    if (existing) {
      delete env[existing]
    }
  }
  for (const [key, value] of Object.entries(plan.set)) {
    // Why reuse the key: on Windows `Path` and `PATH` side by side make the child's PATH undefined.
    env[findEnvKey(env, key, platform) ?? key] = value
  }
  const appended =
    plan.gitConfigEntries.length > 0 ? appendGitConfigEnv(env, plan.gitConfigEntries) : {}
  const gitKeys = Object.keys(appended).filter((key) => GIT_CONFIG_PROTOCOL_KEY_RE.test(key))
  for (const key of gitKeys) {
    env[key] = appended[key]
  }
  const setKeys = new Set([...Object.keys(plan.set), ...gitKeys].map((key) => key.toUpperCase()))
  const kept = (envToDelete ?? []).filter((key) => !setKeys.has(key.toUpperCase()))
  return [...new Set([...kept, ...plan.delete])]
}

/** For direct children (git, gh, scripts, text generation): a new env with deletions applied. */
export function buildClientProfileChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  profile: ClientProfile,
  target: ClientProfileSpawnTarget = { kind: 'local' },
  depsOverride?: ClientProfileEnvDeps
): NodeJS.ProcessEnv {
  const deps = resolveDeps(profile, depsOverride)
  const env = { ...baseEnv }
  applyClientProfileEnvPlan(
    env,
    undefined,
    planClientProfileEnv(profile, target, env, deps),
    deps.platform
  )
  return env
}
