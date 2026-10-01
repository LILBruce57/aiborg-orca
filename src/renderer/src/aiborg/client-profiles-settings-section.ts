import { Contact } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import type { SettingsSearchEntry } from '@/components/settings/settings-search'

export const CLIENT_PROFILES_SETTINGS_SECTION_ID = 'aiborg-client-profiles'

export function getClientProfilesSearchEntries(): SettingsSearchEntry[] {
  return [
    {
      title: translate('aiborg.clientProfile.settings.title', 'Client Profiles'),
      description: translate(
        'aiborg.clientProfile.settings.description',
        'Separate GitHub, git identity, agent logins and cloud credentials per client.'
      ),
      keywords: [
        translate('aiborg.clientProfile.settings.keywordClient', 'client'),
        translate('aiborg.clientProfile.settings.keywordProfile', 'profile'),
        translate('aiborg.clientProfile.settings.keywordIdentity', 'identity'),
        translate('aiborg.clientProfile.settings.keywordGithub', 'github'),
        translate('aiborg.clientProfile.settings.keywordSsh', 'ssh'),
        translate('aiborg.clientProfile.settings.keywordBitwarden', 'bitwarden')
      ]
    }
  ]
}

/** Spread into the capability nav list next to `accounts` (H44). */
export function buildClientProfilesSettingsNavSections(): SettingsNavSection[] {
  return [
    {
      id: CLIENT_PROFILES_SETTINGS_SECTION_ID,
      title: translate('aiborg.clientProfile.settings.title', 'Client Profiles'),
      description: translate(
        'aiborg.clientProfile.settings.description',
        'Separate GitHub, git identity, agent logins and cloud credentials per client.'
      ),
      icon: Contact,
      searchEntries: getClientProfilesSearchEntries(),
      group: 'capabilities'
    }
  ]
}
