import type {
  ClientProfile,
  ClientProfileMachineSettings
} from '../../../shared/aiborg/client-profile-types'
import {
  CLIENT_PROFILE_IDENTITY_KEYS,
  CLIENT_PROFILE_MANAGED_ENV_KEYS
} from '../../../shared/aiborg/client-profile-env-keys'
import {
  clientProfileHomeLayout,
  resolveClientProfilesRoot,
  type ClientProfileHomeLayout
} from '../profiles/client-profile-paths'
import { ClientProfileRefusalError } from '../binding/client-profile-refusal'
import {
  buildClientProfileCommandScopeGitConfig,
  buildClientProfileSshCommand
} from '../profiles/client-profile-git-templates'

export type ClientProfileEnvPlan = {
  set: Record<string, string>
  delete: string[]
  /** Appended (never overwritten) through GIT_CONFIG_COUNT by the wrapper. */
  gitConfigEntries: [string, string][]
  missingSecrets: string[]
}

export type ClientProfileEnvOptions = {
  /** Spawn target; WSL is refused in v1 and SSH only with `remote.allow`. */
  kind: 'local' | 'ssh' | 'wsl'
  platform?: NodeJS.Platform
  /** P root; defaults to AIBORG_PROFILES_ROOT or ~/.aiborg/profiles. */
  root?: string
  machine?: Partial<ClientProfileMachineSettings>
  /** Every loaded profile: their env/secret keys join the managed delete set (§3.2). */
  allProfiles?: readonly ClientProfile[]
  extraManagedKeys?: readonly string[]
  /** Incoming PATH value, so P/bin can be prepended. */
  basePath?: string
  /** The user's env, read for SystemRoot only. */
  systemEnv?: NodeJS.ProcessEnv
}

type ResolvedInput = {
  profile: ClientProfile
  secrets: Readonly<Record<string, string>>
  layout: ClientProfileHomeLayout
  platform: NodeJS.Platform
  machine: ClientProfileMachineSettings
  systemEnv: NodeJS.ProcessEnv
}

function identity(profile: ClientProfile, local: boolean): Record<string, string> {
  const keys: Record<string, string> = {
    [CLIENT_PROFILE_IDENTITY_KEYS.id]: profile.id,
    [CLIENT_PROFILE_IDENTITY_KEYS.name]: profile.name,
    [CLIENT_PROFILE_IDENTITY_KEYS.color]: profile.color
  }
  // SSH gets only AIBORG_PROFILE_* and the allowlist (§3.4).
  if (local) {
    keys[CLIENT_PROFILE_IDENTITY_KEYS.allowedOrgs] = profile.github.allowedOrgs.join(' ')
  }
  return keys
}

function localValues(input: ResolvedInput): {
  set: Record<string, string>
  missingSecrets: string[]
} {
  const { profile, layout, platform } = input
  const set: Record<string, string> = {
    GIT_CONFIG_GLOBAL: layout.gitconfig,
    GIT_SSH_COMMAND: buildClientProfileSshCommand({
      profile,
      layout,
      platform,
      machine: input.machine,
      env: input.systemEnv
    }),
    GH_CONFIG_DIR: layout.gh,
    CLAUDE_CONFIG_DIR: layout.claude,
    CODEX_HOME: layout.codex,
    ORCA_CODEX_HOME: layout.codex,
    AWS_CONFIG_FILE: layout.awsConfig,
    AWS_SHARED_CREDENTIALS_FILE: layout.awsCredentials,
    AZURE_CONFIG_DIR: layout.azure,
    // Why: az's default Windows broker (WAM) keeps accounts in the OS store, outside P/azure.
    AZURE_CORE_ENABLE_BROKER_ON_WINDOWS: 'false',
    CLOUDSDK_CONFIG: layout.gcloud
  }
  if (profile.github.host !== 'github.com') {
    set.GH_HOST = profile.github.host
  }
  if (platform === 'darwin' && input.machine.sshAuthSock) {
    set.SSH_AUTH_SOCK = input.machine.sshAuthSock
  }
  if (profile.aws?.profile) {
    set.AWS_PROFILE = profile.aws.profile
  }
  if (profile.aws?.region) {
    set.AWS_REGION = profile.aws.region
  }
  if (profile.gcloud?.project) {
    set.CLOUDSDK_CORE_PROJECT = profile.gcloud.project
  }
  const missingSecrets: string[] = []
  for (const name of Object.keys(profile.secrets ?? {})) {
    const value = input.secrets[name]
    if (value) {
      set[name] = value
    } else {
      missingSecrets.push(name)
    }
  }
  // Why: for an Enterprise host gh reads GH_ENTERPRISE_TOKEN before GH_TOKEN.
  if (profile.github.host !== 'github.com' && set.GH_TOKEN && !set.GH_ENTERPRISE_TOKEN) {
    set.GH_ENTERPRISE_TOKEN = set.GH_TOKEN
  }
  Object.assign(set, profile.env ?? {})
  return { set, missingSecrets }
}

function remoteValues(profile: ClientProfile): Record<string, string> {
  if (!profile.remote?.allow) {
    return {}
  }
  return Object.fromEntries(
    profile.remote.envAllowlist.flatMap((key) =>
      profile.env && key in profile.env ? [[key, profile.env[key]]] : []
    )
  )
}

function managedKeys(profile: ClientProfile, options: ClientProfileEnvOptions): Set<string> {
  const keys = new Set<string>([
    ...CLIENT_PROFILE_MANAGED_ENV_KEYS,
    ...(options.extraManagedKeys ?? [])
  ])
  for (const item of [profile, ...(options.allProfiles ?? [])]) {
    Object.keys(item.env ?? {}).forEach((key) => keys.add(key))
    Object.keys(item.secrets ?? {}).forEach((key) => keys.add(key))
  }
  return keys
}

/**
 * Pure: the env a spawn under `profile` must carry (design §3). Every managed key the profile
 * does not set is deleted, so values captured by a long-lived daemon or login shell never leak.
 * Throws ClientProfileRefusalError for WSL, and for SSH unless `remote.allow`.
 */
export function buildClientProfileEnv(
  profile: ClientProfile,
  secrets: Readonly<Record<string, string>>,
  options: ClientProfileEnvOptions
): ClientProfileEnvPlan {
  if (options.kind === 'wsl') {
    throw new ClientProfileRefusalError(
      'wsl-unsupported',
      profile.id,
      `AI-Borg: client profile ${profile.name} does not support WSL yet.`
    )
  }
  if (options.kind === 'ssh' && !profile.remote?.allow) {
    throw new ClientProfileRefusalError(
      'ssh-not-allowed',
      profile.id,
      `AI-Borg: client profile ${profile.name} does not allow SSH targets (remote.allow is off).`
    )
  }
  const platform = options.platform ?? process.platform
  const layout = clientProfileHomeLayout(options.root ?? resolveClientProfilesRoot(), profile.id)
  const local =
    options.kind === 'local'
      ? localValues({
          profile,
          secrets,
          layout,
          platform,
          machine: { sshAuthSock: null, windowsSsh: null, ...options.machine },
          systemEnv: options.systemEnv ?? {}
        })
      : null
  const values = local ? local.set : remoteValues(profile)
  const deletes = [...managedKeys(profile, options)].filter((key) => !(key in values)).sort()
  const set: Record<string, string> = { ...identity(profile, local !== null), ...values }
  if (local) {
    const pathDelimiter = platform === 'win32' ? ';' : ':'
    set.PATH = options.basePath ? `${layout.bin}${pathDelimiter}${options.basePath}` : layout.bin
    // Why keep copies: user startup files run after this env is applied; the restore snippet
    // (§3.5) re-exports these and unsets the deleted keys again.
    const kept = Object.keys(values).sort()
    set[CLIENT_PROFILE_IDENTITY_KEYS.bin] = layout.bin
    set[CLIENT_PROFILE_IDENTITY_KEYS.keys] = kept.join(' ')
    set[CLIENT_PROFILE_IDENTITY_KEYS.unset] = deletes.join(' ')
    for (const key of kept) {
      set[`${CLIENT_PROFILE_IDENTITY_KEYS.keepPrefix}${key}`] = values[key]
    }
  }
  return {
    set,
    delete: deletes,
    gitConfigEntries: local ? buildClientProfileCommandScopeGitConfig(profile, layout) : [],
    missingSecrets: local ? local.missingSecrets : []
  }
}
