import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { isOwnerAllowedForClientProfile } from '../../../shared/aiborg/client-profile-schema'
import { appendClientProfileAudit } from '../audit/client-profile-audit'
import { getActiveClientProfile } from '../binding/client-profile-core-access'
import { parseRemoteOwner } from './client-profile-remote-owner'

export type ClientProfileGuardResolvers = {
  /** The worktree's bound profile (repoBindings, else origin owner match); null when unbound. */
  profileForWorktreePath: (worktreePath: string) => ClientProfile | null
}

let guardResolvers: ClientProfileGuardResolvers = { profileForWorktreePath: () => null }

/** Wired once by the binding module (H22); the default treats every repo as unbound. */
export function setClientProfileGuardResolvers(resolvers: ClientProfileGuardResolvers): void {
  guardResolvers = resolvers
}

/** Repo profile, else the active profile for unbound repos (§4.1), else null (personal mode). */
export function resolveGuardProfile(worktreePath: string | null | undefined): ClientProfile | null {
  return (
    (worktreePath ? guardResolvers.profileForWorktreePath(worktreePath) : null) ??
    getActiveClientProfile()
  )
}

export class ClientProfilePushBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClientProfilePushBlockedError'
  }
}

export function formatPushBlockedMessage(profile: ClientProfile, owner: string | null): string {
  return `AI-Borg: push to '${owner ?? 'an unknown remote'}' blocked: profile ${profile.name} only allows: ${profile.github.allowedOrgs.join(' ')}`
}

export type RunGitForPushGuard = (args: string[]) => Promise<{ stdout: string }>

/**
 * App-level push guard (H50-H52): resolves `git remote get-url --push <remote>` and refuses an
 * owner outside the worktree profile's allowedOrgs before git runs. Personal mode allows all.
 */
export async function assertPushAllowed(
  worktreePath: string,
  remote: string,
  runGit: RunGitForPushGuard,
  profileOverride?: ClientProfile | null
): Promise<void> {
  const profile =
    profileOverride === undefined ? resolveGuardProfile(worktreePath) : profileOverride
  if (!profile) {
    return
  }
  let pushUrl: string | null = null
  try {
    pushUrl = (await runGit(['remote', 'get-url', '--push', remote])).stdout.trim()
  } catch {
    // Fail closed: an unreadable push URL cannot be checked.
  }
  const parsed = pushUrl ? parseRemoteOwner(pushUrl) : null
  const allowed =
    parsed !== null &&
    !parsed.rewrittenToBlocked &&
    isOwnerAllowedForClientProfile(profile, parsed.host, parsed.owner)
  appendClientProfileAudit(profile.id, allowed ? 'push.allowed' : 'push.blocked', {
    remote,
    owner: parsed?.owner ?? null,
    via: 'app'
  })
  if (!allowed) {
    throw new ClientProfilePushBlockedError(
      formatPushBlockedMessage(profile, parsed?.owner ?? null)
    )
  }
}
