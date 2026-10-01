import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import {
  CLIENT_PROFILE_SWITCH_ACTION_ID,
  CLIENT_PROFILE_SWITCHER_OPEN_EVENT
} from '../../../shared/aiborg/client-profile-keybindings'
import {
  retainClientProfileSync,
  switchClientProfile,
  useActiveClientProfileIdentity,
  useClientProfileStore
} from './client-profile-store'
import { getClientProfilesApi } from './client-profile-bridge'
import { useClientProfileDocumentIdentity } from './client-profile-document-identity'
import { profileDotStyle } from './client-profile-color-style'
import { CLIENT_PROFILES_SETTINGS_SECTION_ID } from './client-profiles-settings-section'

const PERSONAL_VALUE = '__personal__'

export function openClientProfilesSettings(): void {
  const store = useAppStore.getState()
  store.openSettingsPage()
  store.openSettingsTarget({
    pane: CLIENT_PROFILES_SETTINGS_SECTION_ID,
    repoId: null
  })
}

export function ClientProfileChip(): React.JSX.Element | null {
  const snapshot = useClientProfileStore((s) => s.snapshot)
  const active = useActiveClientProfileIdentity()
  const [open, setOpen] = useState(false)
  const shortcutLabel = useShortcutLabel(CLIENT_PROFILE_SWITCH_ACTION_ID)
  useClientProfileDocumentIdentity(active)

  useEffect(() => retainClientProfileSync(), [])
  useEffect(() => {
    const onOpen = (): void => setOpen(true)
    window.addEventListener(CLIENT_PROFILE_SWITCHER_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(CLIENT_PROFILE_SWITCHER_OPEN_EVENT, onOpen)
  }, [])

  const label = active?.name ?? translate('aiborg.clientProfile.chip.personal', 'Personal')

  const onSelect = (value: string): void => {
    const profileId = value === PERSONAL_VALUE ? null : value
    if (profileId === (active?.id ?? null)) {
      return
    }
    void switchClientProfile(profileId).catch((error: unknown) => {
      toast.error(
        translate('aiborg.clientProfile.chip.switchFailed', 'Could not switch client profile'),
        { description: error instanceof Error ? error.message : String(error) }
      )
    })
  }

  // The paired web client has no client-profile bridge; profiles are a desktop-only feature.
  if (!getClientProfilesApi()) {
    return null
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="aiborg-profile-chip"
          aria-label={translate('aiborg.clientProfile.chip.ariaLabel', 'Client profile: {{name}}', {
            name: label
          })}
        >
          <span
            className="aiborg-profile-dot"
            data-personal={active ? undefined : ''}
            style={active ? profileDotStyle(active.color) : undefined}
          />
          <span className="aiborg-profile-chip-name">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel className="flex items-center">
          {translate('aiborg.clientProfile.chip.menuTitle', 'Client profile')}
          <DropdownMenuShortcut>{shortcutLabel}</DropdownMenuShortcut>
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={active?.id ?? PERSONAL_VALUE} onValueChange={onSelect}>
          {(snapshot?.profiles ?? []).map((entry) => (
            <DropdownMenuRadioItem key={entry.id} value={entry.id} disabled={!entry.profile}>
              <span
                className="aiborg-profile-dot"
                style={entry.profile ? profileDotStyle(entry.profile.color) : undefined}
              />
              <span className="min-w-0 flex-1 truncate">{entry.profile?.name ?? entry.id}</span>
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuRadioItem value={PERSONAL_VALUE}>
            <span className="aiborg-profile-dot" data-personal="" />
            <span className="min-w-0 flex-1 truncate">
              {translate('aiborg.clientProfile.chip.personalOption', 'Personal (no profile)')}
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={openClientProfilesSettings}>
          {translate('aiborg.clientProfile.chip.manage', 'Manage profiles…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
