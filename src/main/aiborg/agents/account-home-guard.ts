import { AgentSessionPreSpawnError } from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  accountHomesEqual,
  clientProfileAgentHome,
  type StructuredAgentKind
} from '../binding/client-profile-account-home'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { auditClientProfile, getClientProfilesRoot } from '../binding/client-profile-core-access'
import {
  resolveWorktreeClientProfile,
  type ClientProfileResolution
} from '../binding/client-profile-resolution'

export { accountHomesEqual, clientProfileAgentHome, type StructuredAgentKind }

function agentLabel(agent: StructuredAgentKind): string {
  return agent === 'claude' ? 'Claude' : 'Codex'
}

/**
 * Invariant 4: a structured session never starts, resumes or adopts under a profile other than
 * its record's home. Personal mode (no profile for the workspace) leaves stock behaviour.
 */
export function assertAccountHomeAllowed(input: {
  provider: StructuredAgentKind
  workspaceId: string
  accountHomePath: string | null | undefined
  action?: 'start' | 'adopt' | 'resume'
  resolved?: ClientProfileResolution
}): void {
  const { provider: agent, accountHomePath: accountHome, action = 'start' } = input
  const resolved = input.resolved ?? resolveWorktreeClientProfile(input.workspaceId)
  if (!resolved.profileId) {
    // Personal mode keeps stock homes, but never runs a client's login under personal env.
    if (accountHome && isPathInsideOrEqual(getClientProfilesRoot(), accountHome)) {
      throw new AgentSessionPreSpawnError(
        new Error(
          `AI-Borg: this ${agentLabel(agent)} session belongs to a client profile; switch to it to ${action} the session.`
        )
      )
    }
    return
  }
  const expected = clientProfileAgentHome(resolved.profileId, agent)
  if (accountHomesEqual(accountHome, expected)) {
    return
  }
  auditClientProfile(resolved.profileId, 'structured.refused', {
    agent,
    action,
    workspaceId: input.workspaceId
  })
  const name = resolved.profile?.name ?? resolved.profileId
  throw new AgentSessionPreSpawnError(
    new Error(
      `AI-Borg: this ${agentLabel(agent)} session belongs to another account home than client profile ${name}, so it cannot ${action} here.`
    )
  )
}
