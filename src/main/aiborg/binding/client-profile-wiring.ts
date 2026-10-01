import { ptyOwnership } from '../../ipc/pty/provider/ownership-state'
import { setClientProfileCodexTrustGrantGate } from '../../../shared/aiborg/client-profile-codex-trust-gate'
import {
  forgetClientProfileAgentHooks,
  installClientProfileAgentHooks
} from '../agents/client-profile-agent-hooks'
import { deleteClientProfileClaudeCredentials } from '../agents/client-profile-claude-keychain'
import { hasLiveClientProfileStructuredChild } from '../agents/client-profile-structured-children'
import { clientProfileCodexTrustGrantEnv } from '../agents/client-profile-usage'
import { setClientProfileGuardResolvers } from '../git/assert-push-allowed'
import { setClientProfileLifecycleHooks } from '../profiles/client-profile-lifecycle'
import { initClientProfilesForMain } from '../ipc/client-profile-ipc'
import { getClientProfileRuntime } from '../profiles/client-profile-runtime'
import { forgetCachedClientProfileSecrets } from './client-profile-core-access'
import {
  resolveCwdClientProfile,
  setClientProfileRepoSource,
  type ClientProfileRepoSource
} from './client-profile-resolution'

function isProfileInUse(profileId: string): boolean {
  const bindings = getClientProfileRuntime()?.sidecar.read().ptyBindings ?? {}
  return (
    hasLiveClientProfileStructuredChild(profileId) ||
    Object.entries(bindings).some(([ptyId, id]) => id === profileId && ptyOwnership.has(ptyId))
  )
}

/**
 * H22 (app): one call from main startup, so headless serve gets profiles even when no window
 * registers the IPC handlers. No new `registerPtyHandlers` parameter.
 */
export function installClientProfileResolution(repos: ClientProfileRepoSource): void {
  setClientProfileRepoSource('app', repos)
  installClientProfileMainHooks()
}

/** Everything H22 wires besides the repo source: runtime, push guards, lifecycle hooks. */
export function installClientProfileMainHooks(): void {
  // The IPC handlers' idempotent init, so the store watcher and state broadcasts come with it.
  initClientProfilesForMain()
  setClientProfileCodexTrustGrantGate(clientProfileCodexTrustGrantEnv)
  setClientProfileGuardResolvers({
    profileForWorktreePath: (worktreePath) => {
      const resolved = resolveCwdClientProfile(worktreePath)
      return resolved.source === 'repo-binding' || resolved.source === 'org'
        ? resolved.profile
        : null
    }
  })
  setClientProfileLifecycleHooks({
    onActivated: async (profile) => {
      await installClientProfileAgentHooks(profile.id)
      // Why: activation is where a broken keychain must surface, not 15 s of cached secrets later.
      forgetCachedClientProfileSecrets()
    },
    onCreated: async (profile) => {
      await installClientProfileAgentHooks(profile.id)
    },
    onDeleted: async (profileId, layout) => {
      forgetClientProfileAgentHooks(profileId)
      try {
        await deleteClientProfileClaudeCredentials(layout.claude)
      } catch (error) {
        console.warn(
          '[aiborg] could not remove the Claude keychain item of a deleted profile',
          error
        )
      }
    },
    isProfileInUse
  })
}
