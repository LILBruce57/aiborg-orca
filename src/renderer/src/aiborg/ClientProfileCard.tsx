import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type {
  ClientProfileListEntry,
  ClientProfileLoginStatus,
  ClientProfileLoginTool
} from '../../../shared/aiborg/client-profile-types'
import { getClientProfilesApi } from './client-profile-bridge'
import { profileDotStyle } from './client-profile-color-style'
import { switchClientProfile } from './client-profile-store'
import { ClientProfileSecretRow } from './ClientProfileSecretRow'
import { clientProfileToolLabel } from './client-profile-tool-labels'

const LOGIN_TOOLS: readonly ClientProfileLoginTool[] = ['gh', 'claude', 'codex', 'az', 'gcloud']

type ClientProfileCardProps = {
  entry: ClientProfileListEntry
  isActive: boolean
  repoNames: string[]
  bitwardenUnlocked: boolean
  keychainAvailable: boolean
  onDelete: (entry: ClientProfileListEntry) => void
}

function useLoginStatus(profileId: string, enabled: boolean): ClientProfileLoginStatus | null {
  const [status, setStatus] = useState<ClientProfileLoginStatus | null>(null)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void getClientProfilesApi()
      ?.getLoginStatus({ profileId })
      .then((next) => {
        if (!cancelled) {
          setStatus(next)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [profileId, enabled])
  return status
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-start gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function ClientProfileCard({
  entry,
  isActive,
  repoNames,
  bitwardenUnlocked,
  keychainAvailable,
  onDelete
}: ClientProfileCardProps): React.JSX.Element {
  const { profile } = entry
  const loginStatus = useLoginStatus(entry.id, profile !== null)
  const secretNames = [
    ...new Set([...Object.keys(profile?.secrets ?? {}), ...Object.keys(entry.secretStatus)])
  ].sort()

  const activate = (): void => {
    void switchClientProfile(entry.id).catch((error: unknown) => {
      toast.error(
        translate('aiborg.clientProfile.chip.switchFailed', 'Could not switch client profile'),
        { description: error instanceof Error ? error.message : String(error) }
      )
    })
  }

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <span
          className="aiborg-profile-dot"
          style={profile ? profileDotStyle(profile.color) : undefined}
        />
        <h3 className="min-w-0 truncate text-sm font-semibold">{profile?.name ?? entry.id}</h3>
        <code className="font-mono text-xs text-muted-foreground">{entry.id}</code>
        {isActive ? (
          <Badge variant="secondary">
            {translate('aiborg.clientProfile.card.active', 'Active')}
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {!isActive && profile ? (
            <Button type="button" variant="outline" size="sm" onClick={activate}>
              {translate('aiborg.clientProfile.card.activate', 'Activate')}
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={translate('aiborg.clientProfile.card.delete', 'Delete profile')}
                onClick={() => onDelete(entry)}
              >
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate('aiborg.clientProfile.card.delete', 'Delete profile')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {entry.errors.length > 0 ? (
        <ul role="alert" className="space-y-0.5 text-xs text-destructive">
          {entry.errors.map((error) => (
            <li key={error} className="break-words font-mono">
              {error}
            </li>
          ))}
        </ul>
      ) : null}

      {profile ? (
        <div className="space-y-2">
          <Field label={translate('aiborg.clientProfile.card.allowedOrgs', 'Allowed orgs')}>
            <span className="font-mono">{profile.github.allowedOrgs.join(', ')}</span>
          </Field>
          <Field label={translate('aiborg.clientProfile.card.gitIdentity', 'Git identity')}>
            {translate('aiborg.clientProfile.card.gitIdentityValue', '{{name}} <{{email}}>', {
              name: profile.git.userName,
              email: profile.git.userEmail
            })}
          </Field>
          <Field label={translate('aiborg.clientProfile.card.logins', 'Logins')}>
            <div className="flex flex-wrap gap-1">
              {LOGIN_TOOLS.map((tool) => (
                <Badge key={tool} variant={loginStatus?.[tool] ? 'secondary' : 'outline'}>
                  {clientProfileToolLabel(tool)}
                  {loginStatus === null
                    ? ''
                    : loginStatus[tool]
                      ? ` · ${translate('aiborg.clientProfile.card.signedIn', 'signed in')}`
                      : ` · ${translate('aiborg.clientProfile.card.signedOut', 'signed out')}`}
                </Badge>
              ))}
            </div>
          </Field>
          <Field label={translate('aiborg.clientProfile.card.repos', 'Bound repositories')}>
            {repoNames.length > 0
              ? repoNames.join(', ')
              : translate('aiborg.clientProfile.card.noRepos', 'None open in AI-Borg')}
          </Field>
          {secretNames.length > 0 ? (
            <Field label={translate('aiborg.clientProfile.card.secrets', 'Secrets')}>
              <div className="space-y-3">
                {secretNames.map((name) => (
                  <ClientProfileSecretRow
                    key={name}
                    profileId={entry.id}
                    name={name}
                    state={entry.secretStatus[name] ?? 'missing'}
                    bitwardenRef={profile.secrets?.[name]?.bitwarden ?? null}
                    bitwardenUnlocked={bitwardenUnlocked}
                    readOnly={!keychainAvailable}
                  />
                ))}
              </div>
            </Field>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
