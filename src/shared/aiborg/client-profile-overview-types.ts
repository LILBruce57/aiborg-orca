// Renderer payload of the per-profile overview (design §8 Phase 4). Parsed fields only: never env,
// tokens or raw gh output.

export type ClientProfileOverviewItem = {
  kind: 'pr' | 'issue'
  /** `owner/name`. */
  repo: string
  number: number
  title: string
  url: string
  updatedAt: string
  isDraft: boolean
  author: string | null
}

export type ClientProfileOverviewBranch = {
  repo: string
  name: string
  url: string
  committedAt: string | null
}

/** Why GitHub could not (fully) answer for one org; the message is redacted GitHub text. */
export type ClientProfileOverviewProblem = {
  kind: 'sso' | 'not-found' | 'forbidden' | 'failed'
  message: string
}

export type ClientProfileOverviewOrg = {
  org: string
  /** Set when a list or repo of this org could not be read: its lists may be incomplete. */
  problem: ClientProfileOverviewProblem | null
  /** Open PRs the viewer authored or is assigned to. */
  pullRequests: ClientProfileOverviewItem[]
  reviewRequests: ClientProfileOverviewItem[]
  issues: ClientProfileOverviewItem[]
  branches: ClientProfileOverviewBranch[]
}

export type ClientProfileOverviewErrorReason =
  | 'no-active-profile'
  | 'profile-unavailable'
  | 'profile-changed'
  | 'gh-missing'
  | 'not-authenticated'
  | 'token-rejected'
  | 'rate-limited'
  | 'failed'

export type ClientProfileOverviewResult =
  | {
      ok: true
      profileId: string
      host: string
      viewerLogin: string | null
      fetchedAt: number
      cached: boolean
      orgs: ClientProfileOverviewOrg[]
      /** Repos of the profile Orca knows whose recent branches were asked for. */
      repoCount: number
      /** A search hit its page size. */
      partial: boolean
      /** More known repos matched than the branch query covers. */
      reposTruncated: boolean
      /** A GitHub error not tied to one org (redacted). */
      problem: ClientProfileOverviewProblem | null
      /** Set when a refresh hit the rate limit and this is the last good answer. */
      rateLimitMessage: string | null
    }
  | {
      ok: false
      profileId: string | null
      reason: ClientProfileOverviewErrorReason
      message: string
    }
