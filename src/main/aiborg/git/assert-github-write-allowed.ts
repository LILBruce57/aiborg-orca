import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { appendClientProfileAudit } from '../audit/client-profile-audit'
import { resolveGuardProfile } from './assert-push-allowed'

export type GitHubWriteOperation =
  | 'pr.create'
  | 'pr.review-comment'
  | 'issue.comment'
  | 'pr.merge'
  | 'pr.stack-merge'
  /** Central gh guard: `<command>.<verb>` or `api.<method>`. */
  | `${string}.${string}`

export class ClientProfileGitHubWriteBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClientProfileGitHubWriteBlockedError'
  }
}

/**
 * GitHub API writes bypass every push guard (H54). Refuses before any request when `owner` is
 * outside the profile's allowedOrgs; the PAT's scope stays the hard limit.
 */
export function assertGitHubWriteAllowed(input: {
  owner: string
  operation: GitHubWriteOperation
  /** Local repo or worktree path, when the caller has one; else the active profile applies. */
  repoPath?: string | null
  profile?: ClientProfile | null
}): void {
  const profile = input.profile === undefined ? resolveGuardProfile(input.repoPath) : input.profile
  if (!profile) {
    return
  }
  const owner = input.owner.trim().toLowerCase()
  if (owner && profile.github.allowedOrgs.includes(owner)) {
    return
  }
  appendClientProfileAudit(profile.id, 'github.write.blocked', {
    owner,
    operation: input.operation
  })
  throw new ClientProfileGitHubWriteBlockedError(
    `AI-Borg: ${input.operation} on '${owner || 'unknown owner'}' blocked: profile ${profile.name} only allows: ${profile.github.allowedOrgs.join(' ')}`
  )
}
