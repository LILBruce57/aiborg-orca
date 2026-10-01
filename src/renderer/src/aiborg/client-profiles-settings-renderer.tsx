import { SettingsSection } from '@/components/settings/SettingsSection'
import type { SettingsRenderContext } from '@/components/settings/settings-render-context'
import { translate } from '@/i18n/i18n'
import { CLIENT_PROFILES_SETTINGS_SECTION_ID } from './client-profiles-settings-section'
import { ClientProfilesPane } from './ClientProfilesPane'

/** Rendered from settings-page-renderer.tsx next to the accounts section (H44). */
export function renderClientProfilesSettingsSection(
  context: SettingsRenderContext
): React.JSX.Element {
  const { navigation, view } = context
  return (
    <SettingsSection
      id={CLIENT_PROFILES_SETTINGS_SECTION_ID}
      title={translate('aiborg.clientProfile.settings.title', 'Client Profiles')}
      description={translate(
        'aiborg.clientProfile.settings.description',
        'Separate GitHub, git identity, agent logins and cloud credentials per client.'
      )}
      searchEntries={navigation.getSectionSearchEntries(CLIENT_PROFILES_SETTINGS_SECTION_ID)}
    >
      {view.isSectionMounted(CLIENT_PROFILES_SETTINGS_SECTION_ID) ? <ClientProfilesPane /> : null}
    </SettingsSection>
  )
}
