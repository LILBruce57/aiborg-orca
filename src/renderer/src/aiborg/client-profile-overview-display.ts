import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type {
  ClientProfileOverviewProblem,
  ClientProfileOverviewResult
} from '../../../shared/aiborg/client-profile-overview-types'

type OverviewFailure = Extract<ClientProfileOverviewResult, { ok: false }>

/**
 * The answer that may be shown for the active profile. After a switch the previous profile's
 * answer stays in state until the new one arrives; it must not reach the header or the body.
 * A profile-less failure is the IPC call itself failing, which names no client.
 */
export function currentOverviewResult(
  result: ClientProfileOverviewResult | null,
  activeId: string | null
): ClientProfileOverviewResult | null {
  if (!result) {
    return null
  }
  if (result.profileId === activeId) {
    return result
  }
  return result.profileId === null && !result.ok && result.reason === 'failed' ? result : null
}

export function overviewHeaderDescription(current: ClientProfileOverviewResult | null): string {
  if (!current?.ok) {
    return translate(
      'aiborg.clientProfile.overview.description',
      'Open pull requests, review requests, issues and branches in this profile’s orgs.'
    )
  }
  const updated = formatUiRelativeTime(current.fetchedAt - Date.now())
  return current.viewerLogin
    ? translate(
        'aiborg.clientProfile.overview.signedInAs',
        '{{login}} on {{host}} · updated {{updated}}',
        { login: current.viewerLogin, host: current.host, updated }
      )
    : translate('aiborg.clientProfile.overview.updated', 'Updated {{updated}}', { updated })
}

export function overviewProblemTitle(reason: OverviewFailure['reason']): string {
  switch (reason) {
    case 'no-active-profile':
      return translate(
        'aiborg.clientProfile.overview.noProfile',
        'Activate a client profile to see its overview.'
      )
    case 'not-authenticated':
      return translate(
        'aiborg.clientProfile.overview.notAuthenticated',
        'gh is not logged in for this profile.'
      )
    case 'token-rejected':
      return translate(
        'aiborg.clientProfile.overview.tokenRejected',
        'GitHub rejected the stored GH_TOKEN of this profile. Replace it in Settings → Client profiles.'
      )
    case 'gh-missing':
      return translate(
        'aiborg.clientProfile.overview.ghMissing',
        'The GitHub CLI (gh) is not installed.'
      )
    case 'rate-limited':
      return translate(
        'aiborg.clientProfile.overview.rateLimited',
        'GitHub rate limit reached. Try again in a few minutes.'
      )
    case 'profile-changed':
      return translate(
        'aiborg.clientProfile.overview.profileChanged',
        'The active profile changed while loading.'
      )
    case 'profile-unavailable':
    case 'failed':
      return translate('aiborg.clientProfile.overview.failed', 'Could not load the overview.')
  }
}

/** Failures whose redacted gh text helps (the reset time, the gh error); the rest say it all. */
export function overviewProblemShowsDetail(reason: OverviewFailure['reason']): boolean {
  return reason === 'failed' || reason === 'profile-unavailable' || reason === 'rate-limited'
}

/** What a GitHub error means for one org (or for the whole answer when `org` is null). */
export function overviewOrgProblemText(
  problem: ClientProfileOverviewProblem,
  org: string | null
): string {
  const name = org ?? translate('aiborg.clientProfile.overview.thisOrg', 'this org')
  switch (problem.kind) {
    case 'sso':
      return translate(
        'aiborg.clientProfile.overview.problemSso',
        'Authorize this token for SSO in {{org}}; until then its items are hidden.',
        { org: name }
      )
    case 'not-found':
      return translate(
        'aiborg.clientProfile.overview.problemNotFound',
        '{{org}} or one of its repos was not found, or this account cannot see it.',
        { org: name }
      )
    case 'forbidden':
      return translate(
        'aiborg.clientProfile.overview.problemForbidden',
        'This account has no access to part of {{org}}.',
        { org: name }
      )
    case 'failed':
      return translate(
        'aiborg.clientProfile.overview.problemFailed',
        'Part of {{org}} could not be read; the lists may be incomplete.',
        { org: name }
      )
  }
}
