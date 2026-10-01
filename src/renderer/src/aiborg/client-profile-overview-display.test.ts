// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientProfileOverviewResult } from '../../../shared/aiborg/client-profile-overview-types'
import {
  currentOverviewResult,
  overviewHeaderDescription,
  overviewProblemShowsDetail
} from './client-profile-overview-display'
import { CLIENT_PROFILE_OVERVIEW_OPEN_EVENT } from './client-profile-overview-open'
import { getClientProfileOverviewQuickActions } from './client-profile-overview-quick-action'

function acmeResult(): ClientProfileOverviewResult {
  return {
    ok: true,
    profileId: 'acme',
    host: 'github.com',
    viewerLogin: 'example-acme-login',
    fetchedAt: Date.now(),
    cached: false,
    orgs: [],
    repoCount: 0,
    partial: false,
    reposTruncated: false,
    problem: null,
    rateLimitMessage: null
  }
}

describe('client profile overview display', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'aiborg')
  })

  it("never shows the previous profile's answer after a switch, in header or body", () => {
    const stale = acmeResult()
    expect(currentOverviewResult(stale, 'acme')).toBe(stale)
    expect(currentOverviewResult(stale, 'contoso')).toBeNull()
    expect(currentOverviewResult(stale, null)).toBeNull()
    const header = overviewHeaderDescription(currentOverviewResult(stale, 'contoso'))
    expect(header).not.toContain('example-acme-login')
    expect(overviewHeaderDescription(currentOverviewResult(stale, 'acme'))).toContain(
      'example-acme-login'
    )
  })

  it("drops another profile's failure too, but keeps an IPC failure that names no profile", () => {
    const acmeFailure: ClientProfileOverviewResult = {
      ok: false,
      profileId: 'acme',
      reason: 'token-rejected',
      message: 'rejected'
    }
    expect(currentOverviewResult(acmeFailure, 'contoso')).toBeNull()
    const noProfile: ClientProfileOverviewResult = {
      ok: false,
      profileId: null,
      reason: 'no-active-profile',
      message: 'none'
    }
    expect(currentOverviewResult(noProfile, 'contoso')).toBeNull()
    expect(currentOverviewResult(noProfile, null)).toBe(noProfile)
    const ipc: ClientProfileOverviewResult = { ...noProfile, reason: 'failed' }
    expect(currentOverviewResult(ipc, 'contoso')).toBe(ipc)
  })

  it('shows the rate-limit detail (it carries the reset time)', () => {
    expect(overviewProblemShowsDetail('rate-limited')).toBe(true)
    expect(overviewProblemShowsDetail('token-rejected')).toBe(false)
  })

  it('the Cmd+J entry is always available on desktop and just opens the sheet', async () => {
    expect(getClientProfileOverviewQuickActions()).toEqual([])
    Object.assign(window, { aiborg: { clientProfiles: {} } })
    const [action] = getClientProfileOverviewQuickActions()
    expect(action.kind).toBe('action')
    if (action.kind !== 'action') {
      return
    }
    // The entry ignores the palette context, so it is called without one.
    expect(Reflect.apply(action.isAvailable, undefined, [])).toEqual({ available: true })
    const opened = vi.fn()
    window.addEventListener(CLIENT_PROFILE_OVERVIEW_OPEN_EVENT, opened)
    expect(await Reflect.apply(action.run, undefined, [])).toEqual({ status: 'ok' })
    window.removeEventListener(CLIENT_PROFILE_OVERVIEW_OPEN_EVENT, opened)
    expect(opened).toHaveBeenCalledTimes(1)
  })
})
