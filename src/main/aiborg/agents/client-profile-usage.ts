import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import type { CodexRateLimitFetchOptions } from '../../rate-limits/codex-rate-limit-fetch-options'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { getClientProfilesRoot } from '../binding/client-profile-core-access'
import { resolveActiveClientProfile } from '../binding/client-profile-resolution'
import { clientProfileAgentHome } from '../binding/client-profile-account-home'
import {
  clientProfileIdForAccountHome,
  withClientProfileEnvForAccountHome
} from './profile-agent-env'

// H60: usage, rate-limit and trust-grant readers. In profile mode they read the active profile's
// homes or stay hidden; they never start `claude` or `codex app-server` against the user's home.

function activeProfileId(): string | null {
  return resolveActiveClientProfile().profileId
}

/** Claude usage reads `~/.claude` credentials and the macOS keychain; hidden in profile mode. */
export function clientProfileClaudeUsageHidden(): ProviderRateLimits | null {
  if (!activeProfileId()) {
    return null
  }
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Usage is hidden while a client profile is active',
    status: 'unavailable'
  }
}

/** Codex usage probes run under the active profile's `P/codex`. */
export function withClientProfileCodexUsageHome(
  options: CodexRateLimitFetchOptions | undefined
): CodexRateLimitFetchOptions | undefined {
  const profileId = activeProfileId()
  return profileId
    ? { ...options, codexHomePath: clientProfileAgentHome(profileId, 'codex') }
    : options
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

/**
 * H60c/H60e: a `codex app-server` started in a profile's `P/codex` (usage probe, state-db
 * recovery) gets that profile's full env: managed keys deleted, profile values set. Other homes
 * pass through unchanged.
 */
export function withClientProfileCodexHomeEnv(
  codexHome: string | null | undefined,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return codexHome && clientProfileIdForAccountHome(codexHome, 'codex')
    ? withClientProfileEnvForAccountHome('codex', codexHome, definedEnv(env))
    : env
}

/**
 * Trust grants spawn `codex app-server` in the target home: outside profile homes they wait
 * while a profile is active; inside one they run with that profile's env (H60d).
 */
export function clientProfileCodexTrustGrantEnv(invocation: {
  env?: Record<string, string>
}): Record<string, string> | undefined {
  const home = invocation.env?.CODEX_HOME
  const inProfileHome = Boolean(home && isPathInsideOrEqual(getClientProfilesRoot(), home))
  if (activeProfileId() && !inProfileHome) {
    throw new Error(
      'AI-Borg: a client profile is active; Codex trust grants outside client profile homes are skipped.'
    )
  }
  if (!home || !clientProfileIdForAccountHome(home, 'codex')) {
    return undefined
  }
  return withClientProfileEnvForAccountHome('codex', home, {
    ...definedEnv(process.env),
    ...invocation.env
  })
}
