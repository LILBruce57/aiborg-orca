import { relative, isAbsolute, sep } from 'node:path'
import { CLIENT_PROFILE_IDENTITY_KEYS } from '../../../shared/aiborg/client-profile-env-keys'
import { CLIENT_PROFILE_ID_RE } from '../../../shared/aiborg/client-profile-schema'
import { AgentSessionPreSpawnError } from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { getClientProfilesRoot } from '../binding/client-profile-core-access'
import {
  applyClientProfileEnvApplication,
  buildClientProfileEnvApplication
} from '../binding/client-profile-process-env'
import {
  resolveActiveClientProfile,
  resolveClientProfileById,
  resolveWorktreeClientProfile,
  type ClientProfileResolution
} from '../binding/client-profile-resolution'
import {
  accountHomesEqual,
  assertAccountHomeAllowed,
  clientProfileAgentHome,
  type StructuredAgentKind
} from './account-home-guard'

type StructuredRecordLike = {
  location: { workspaceId: string }
  accountHome: { path: string }
}

/**
 * H30: the agent homes a structured session for this workspace is created with: the profile's
 * `P/claude` and `P/codex` plus its id marker, or nothing in personal mode.
 */
export function profileAgentEnv(input: { workspaceId: string | null }): {
  env: Record<string, string>
  envToDelete: string[]
} {
  const resolved = input.workspaceId
    ? resolveWorktreeClientProfile(input.workspaceId)
    : resolveActiveClientProfile()
  return { env: agentHomeEnv(resolved), envToDelete: [] }
}

function agentHomeEnv(resolved: ClientProfileResolution): Record<string, string> {
  if (!resolved.profileId) {
    return {}
  }
  return {
    CLAUDE_CONFIG_DIR: clientProfileAgentHome(resolved.profileId, 'claude'),
    CODEX_HOME: clientProfileAgentHome(resolved.profileId, 'codex'),
    [CLIENT_PROFILE_IDENTITY_KEYS.id]: resolved.profileId
  }
}

/** H30: a new structured session pins the workspace profile's `P/claude` or `P/codex`. */
export function withClientProfileAgentLaunchEnv(
  workspaceId: string,
  launchEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return { ...launchEnv, ...profileAgentEnv({ workspaceId }).env }
}

/** H30: record-less reads (model picker) follow the active profile's homes. */
export function withActiveClientProfileAgentLaunchEnv(
  launchEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return { ...launchEnv, ...profileAgentEnv({ workspaceId: null }).env }
}

/** H30: adopting a transcript must not pull another profile's (or the personal) home in. */
export function assertClientProfileAdoptionHome(
  agent: StructuredAgentKind,
  workspaceId: string,
  adoptedHome: string | null | undefined
): void {
  if (adoptedHome) {
    assertAccountHomeAllowed({
      provider: agent,
      workspaceId,
      accountHomePath: adoptedHome,
      action: 'adopt'
    })
  }
}

/** H32: the profile home H30 pinned, returned before Orca's `~/.codex` runtime copy is touched. */
export function clientProfileCodexHomeFromLaunchEnv(launchEnv: NodeJS.ProcessEnv): string | null {
  const profileId = launchEnv[CLIENT_PROFILE_IDENTITY_KEYS.id]?.trim()
  return profileId && CLIENT_PROFILE_ID_RE.test(profileId)
    ? clientProfileAgentHome(profileId, 'codex')
    : null
}

/** H33: the default for the Claude resolver's `assertAccountHomeAllowed` dep. */
export function assertClaudeClientProfileHome(record: StructuredRecordLike): void {
  assertStructuredClientProfileHome(record, 'claude')
}

/** H33/H34: each start of a structured session re-checks its record's home (invariant 4). */
export function assertStructuredClientProfileHome(
  record: StructuredRecordLike,
  agent: StructuredAgentKind
): void {
  assertAccountHomeAllowed({
    provider: agent,
    workspaceId: record.location.workspaceId,
    accountHomePath: record.accountHome.path
  })
}

function profiledEnv(
  resolved: ClientProfileResolution,
  agent: StructuredAgentKind,
  baseEnv: Record<string, string | undefined>
): Record<string, string> | null {
  try {
    const application = buildClientProfileEnvApplication(resolved, {
      target: { kind: 'local' },
      baseEnv,
      action: `structured.${agent}`
    })
    if (!application) {
      return null
    }
    const next: Record<string, string | undefined> = { ...baseEnv }
    applyClientProfileEnvApplication(next, application)
    return definedEnv(next)
  } catch (error) {
    // Pre-spawn: the chat shows the refusal instead of treating it as a crash.
    throw new AgentSessionPreSpawnError(error)
  }
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

/** H23: the structured Claude child env under its record's workspace profile. */
export function withStructuredClientProfileEnv(
  record: StructuredRecordLike,
  agent: StructuredAgentKind,
  env: Record<string, string>
): Record<string, string> {
  return profiledEnv(resolveWorktreeClientProfile(record.location.workspaceId), agent, env) ?? env
}

/** H24: same for Codex; the result beats `resolveCodexOverrides`, which is already merged in. */
export function withStructuredClientProfileInvocation<
  T extends { environment: NodeJS.ProcessEnv | undefined }
>(record: StructuredRecordLike, invocation: T): T {
  const resolved = resolveWorktreeClientProfile(record.location.workspaceId)
  // Why process.env as the fallback base: P/bin is prepended to the PATH it carries.
  const environment = profiledEnv(resolved, 'codex', invocation.environment ?? process.env)
  return environment ? { ...invocation, environment } : invocation
}

/** Profile id when `home` is a profile's own `P/claude` or `P/codex`. */
export function clientProfileIdForAccountHome(
  home: string,
  agent: StructuredAgentKind
): string | null {
  const rel = relative(getClientProfilesRoot(), home)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return null
  }
  const profileId = rel.split(sep)[0]
  return profileId &&
    CLIENT_PROFILE_ID_RE.test(profileId) &&
    accountHomesEqual(home, clientProfileAgentHome(profileId, agent))
    ? profileId
    : null
}

/** Model-catalog probes under a profile home get that profile's env, like its sessions. */
export function withClientProfileEnvForAccountHome(
  agent: StructuredAgentKind,
  accountHome: string,
  env: Record<string, string>
): Record<string, string> {
  const profileId = clientProfileIdForAccountHome(accountHome, agent)
  if (!profileId) {
    return env
  }
  return profiledEnv(resolveClientProfileById(profileId, 'pty'), agent, env) ?? env
}
