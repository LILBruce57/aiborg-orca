import { mkdirSync } from 'node:fs'
import type { AgentHookInstallStatus } from '../../../shared/agent-hook-types'
import { claudeHookService } from '../../claude/hook-service'
import { codexHookService } from '../../codex/hook-service'
import { CLIENT_PROFILE_IDENTITY_KEYS } from '../../../shared/aiborg/client-profile-env-keys'
import { CLIENT_PROFILE_ID_RE } from '../../../shared/aiborg/client-profile-schema'
import { clientProfileAgentHome } from '../binding/client-profile-account-home'
import { getClientProfileLayout } from '../binding/client-profile-core-access'
import { resolveActiveClientProfile } from '../binding/client-profile-resolution'

export type ClientProfileAgentHookResult = {
  claude: AgentHookInstallStatus
  codex: AgentHookInstallStatus | null
}

const installedThisSession = new Set<string>()

/**
 * Orca's status hooks in the profile's own homes (design §4.3): terminal Claude reads
 * `P/claude/settings.json`, Codex reads `P/codex`. Called on profile creation and activation.
 */
export async function installClientProfileAgentHooks(
  profileId: string,
  options: { claudeVersion?: string } = {}
): Promise<ClientProfileAgentHookResult> {
  const layout = getClientProfileLayout(profileId)
  mkdirSync(layout.claude, { recursive: true })
  mkdirSync(layout.codex, { recursive: true })
  const claude = claudeHookService.install({
    ...(options.claudeVersion ? { claudeVersion: options.claudeVersion } : {}),
    configDir: layout.claude
  })
  let codex: AgentHookInstallStatus | null = null
  try {
    codex = await codexHookService.install(layout.codex)
  } catch (error) {
    console.warn(
      '[aiborg] codex hook install failed for client profile',
      error instanceof Error ? error.message : error
    )
  }
  installedThisSession.add(profileId)
  return { claude, codex }
}

/** Launch paths call this so a profile activated by another build still gets its hooks. */
export function ensureClientProfileAgentHooks(profileId: string): void {
  if (installedThisSession.has(profileId)) {
    return
  }
  installedThisSession.add(profileId)
  void installClientProfileAgentHooks(profileId).catch((error: unknown) => {
    installedThisSession.delete(profileId)
    console.warn(
      '[aiborg] client profile hook install failed',
      error instanceof Error ? error.message : error
    )
  })
}

export function getClientProfileClaudeHookStatus(profileId: string): AgentHookInstallStatus {
  return claudeHookService.getStatus({
    configDir: getClientProfileLayout(profileId).claude
  })
}

/** Delete flow: P/claude and P/codex are wiped, so a recreated profile must install again. */
export function forgetClientProfileAgentHooks(profileId: string): void {
  installedThisSession.delete(profileId)
}

/**
 * H60: Codex launch preparation (terminals and structured sessions). A profile home (from the
 * launch env's profile marker, else the active profile) replaces the `~/.codex` runtime sync.
 */
export function clientProfileCodexLaunchHome(
  launchEnv: NodeJS.ProcessEnv | undefined,
  target: { runtime?: string } | undefined
): string | null {
  if (target?.runtime === 'wsl') {
    return null
  }
  const markerId = launchEnv?.[CLIENT_PROFILE_IDENTITY_KEYS.id]?.trim()
  const profileId =
    markerId && CLIENT_PROFILE_ID_RE.test(markerId)
      ? markerId
      : resolveActiveClientProfile().profileId
  if (!profileId) {
    return null
  }
  ensureClientProfileAgentHooks(profileId)
  return clientProfileAgentHome(profileId, 'codex')
}
