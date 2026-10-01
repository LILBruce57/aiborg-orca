import { LayoutList } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { CmdJQuickAction } from '@/components/cmd-j/quick-actions'
import { getClientProfilesApi } from './client-profile-bridge'
import { openClientProfileOverview } from './client-profile-overview-open'

/**
 * Cmd+J "Client Profile Overview"; desktop only. Always available: the palette memoizes
 * availability without watching the profile store, and the sheet itself explains Personal mode.
 */
export function getClientProfileOverviewQuickActions(): CmdJQuickAction[] {
  if (!getClientProfilesApi()) {
    return []
  }
  return [
    {
      id: 'aiborg-client-profile-overview',
      kind: 'action',
      title: translate('aiborg.clientProfile.overview.quickActionTitle', 'Client Profile Overview'),
      description: translate(
        'aiborg.clientProfile.overview.quickActionDescription',
        'Open pull requests, reviews, issues and branches of the active client profile.'
      ),
      icon: LayoutList,
      verbKeywords: [
        translate('aiborg.clientProfile.overview.verbs.overview', 'client overview'),
        translate('aiborg.clientProfile.overview.verbs.prs', 'my pull requests'),
        translate('aiborg.clientProfile.overview.verbs.reviews', 'review requests')
      ],
      isAvailable: () => ({ available: true }),
      run: async () => {
        openClientProfileOverview()
        return { status: 'ok' }
      }
    }
  ]
}
