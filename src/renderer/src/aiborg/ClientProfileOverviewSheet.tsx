import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import type { ClientProfileOverviewResult } from '../../../shared/aiborg/client-profile-overview-types'
import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { getClientProfilesApi } from './client-profile-bridge'
import { findClientProfileEntry, useClientProfileStore } from './client-profile-store'
import { profileDotStyle } from './client-profile-color-style'
import { loginCommandFor } from './client-profile-setup-commands'
import { ClientProfileSetupCommandRow } from './ClientProfileSetupCommandRow'
import { ClientProfileOverviewOrgSection } from './ClientProfileOverviewSections'
import {
  currentOverviewResult,
  overviewHeaderDescription,
  overviewOrgProblemText,
  overviewProblemShowsDetail,
  overviewProblemTitle
} from './client-profile-overview-display'

type OverviewFailure = Extract<ClientProfileOverviewResult, { ok: false }>

function OverviewProblem({
  failure,
  profile
}: {
  failure: OverviewFailure
  profile: ClientProfile | null
}): React.JSX.Element {
  const showDetail = overviewProblemShowsDetail(failure.reason)
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm">{overviewProblemTitle(failure.reason)}</p>
          {showDetail ? (
            <p className="text-xs break-words text-muted-foreground">{failure.message}</p>
          ) : null}
        </div>
      </div>
      {failure.reason === 'not-authenticated' && profile ? (
        <ClientProfileSetupCommandRow
          profileId={profile.id}
          label={translate(
            'aiborg.clientProfile.overview.loginLabel',
            'Log gh in for this profile'
          )}
          command={loginCommandFor('gh', profile)}
          hint={translate(
            'aiborg.clientProfile.overview.loginHint',
            'Or store a GH_TOKEN for this profile in Settings → Client profiles.'
          )}
        />
      ) : null}
      {failure.reason === 'gh-missing' ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void window.api.shell.openUrl('https://cli.github.com/')}
        >
          {translate('aiborg.clientProfile.overview.installGh', 'Install the GitHub CLI')}
        </Button>
      ) : null}
    </div>
  )
}

type OverviewState = { loading: boolean; result: ClientProfileOverviewResult | null }

function useClientProfileOverview(
  open: boolean,
  activeId: string | null
): OverviewState & { refresh: () => void } {
  const [state, setState] = useState<OverviewState>({ loading: false, result: null })
  const requestRef = useRef(0)
  const load = useCallback(async (force: boolean) => {
    const api = getClientProfilesApi()
    if (!api) {
      return
    }
    const request = ++requestRef.current
    setState((current) => ({ ...current, loading: true }))
    let result: ClientProfileOverviewResult
    try {
      result = await api.getOverview({ force })
    } catch (error) {
      result = {
        ok: false,
        profileId: null,
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
    // Why: a profile switch mid-request starts a new one; the older answer is dropped.
    if (request === requestRef.current) {
      setState({ loading: false, result })
    }
  }, [])
  useEffect(() => {
    if (open) {
      void load(false)
    }
  }, [open, activeId, load])
  return { ...state, refresh: () => void load(true) }
}

function OverviewNote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="flex items-start gap-2 px-2 text-xs break-words text-muted-foreground">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

function OverviewBody({
  current,
  profile
}: {
  current: ClientProfileOverviewResult | null
  profile: ClientProfile | null
}): React.JSX.Element {
  if (!current) {
    return (
      <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {translate('aiborg.clientProfile.overview.loading', 'Loading overview…')}
      </div>
    )
  }
  if (!current.ok) {
    return <OverviewProblem failure={current} profile={profile} />
  }
  const expected = profile?.github.login
  const loginMismatch =
    expected && current.viewerLogin && expected.toLowerCase() !== current.viewerLogin.toLowerCase()
  return (
    <div className="space-y-5">
      {current.rateLimitMessage ? (
        <OverviewNote>
          {translate(
            'aiborg.clientProfile.overview.rateLimitedStale',
            'GitHub rate limit reached; showing the last loaded answer. {{detail}}',
            { detail: current.rateLimitMessage }
          )}
        </OverviewNote>
      ) : null}
      {loginMismatch ? (
        <OverviewNote>
          {translate(
            'aiborg.clientProfile.overview.loginMismatch',
            'gh is signed in as {{actual}}; this profile expects {{expected}}.',
            { actual: current.viewerLogin ?? '', expected: expected ?? '' }
          )}
        </OverviewNote>
      ) : null}
      {current.problem ? (
        <OverviewNote>
          {overviewOrgProblemText(current.problem, null)} {current.problem.message}
        </OverviewNote>
      ) : null}
      {current.partial ? (
        <p className="px-2 text-xs text-muted-foreground">
          {translate(
            'aiborg.clientProfile.overview.partial',
            'Some results are not shown: a list hit its limit.'
          )}
        </p>
      ) : null}
      {current.reposTruncated ? (
        <p className="px-2 text-xs text-muted-foreground">
          {translate(
            'aiborg.clientProfile.overview.reposTruncated',
            'Recent branches cover the first {{count}} repos of this profile only.',
            { count: current.repoCount }
          )}
        </p>
      ) : null}
      {current.orgs.map((org) => (
        <ClientProfileOverviewOrgSection key={org.org} org={org} host={current.host} />
      ))}
    </div>
  )
}

export function ClientProfileOverviewSheet({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const snapshot = useClientProfileStore((s) => s.snapshot)
  const activeId = snapshot?.activeProfileId ?? null
  const profile = findClientProfileEntry(snapshot, activeId)?.profile ?? null
  const state = useClientProfileOverview(open, activeId)
  // Why once: header and body must both ignore the previous profile's answer after a switch.
  const current = currentOverviewResult(state.result, activeId)
  const name = profile?.name ?? translate('aiborg.clientProfile.chip.personal', 'Personal')

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[480px] sm:max-w-[480px]">
        <div className="border-b border-border">
          <SheetHeader>
            <div className="flex items-center gap-2 pr-8">
              <span
                className="aiborg-profile-dot"
                data-personal={profile ? undefined : ''}
                style={profile ? profileDotStyle(profile.color) : undefined}
              />
              <div className="min-w-0 flex-1 truncate">
                <SheetTitle>
                  {translate('aiborg.clientProfile.overview.title', '{{name}} overview', { name })}
                </SheetTitle>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={state.loading || !activeId}
                aria-label={translate('aiborg.clientProfile.overview.refresh', 'Refresh')}
                title={translate('aiborg.clientProfile.overview.refresh', 'Refresh')}
                onClick={state.refresh}
              >
                {state.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </Button>
            </div>
            <SheetDescription>{overviewHeaderDescription(current)}</SheetDescription>
          </SheetHeader>
        </div>
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-3">
          <OverviewBody current={current} profile={profile} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
