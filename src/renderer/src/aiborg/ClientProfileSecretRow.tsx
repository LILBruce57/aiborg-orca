import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { ClientProfileSecretState } from '../../../shared/aiborg/client-profile-types'
import { getClientProfilesApi } from './client-profile-bridge'
import { refreshClientProfiles } from './client-profile-store'

type ClientProfileSecretRowProps = {
  profileId: string
  name: string
  state: ClientProfileSecretState
  bitwardenRef: string | null
  bitwardenUnlocked: boolean
  readOnly: boolean
}

function secretStateLabel(state: ClientProfileSecretState): string {
  if (state === 'set') {
    return translate('aiborg.clientProfile.secret.set', 'Set')
  }
  if (state === 'missing') {
    return translate('aiborg.clientProfile.secret.missing', 'Missing')
  }
  return translate('aiborg.clientProfile.secret.unknown', 'Unknown')
}

function reportError(error: unknown): void {
  toast.error(translate('aiborg.clientProfile.secret.failed', 'Could not update the secret'), {
    description: error instanceof Error ? error.message : String(error)
  })
}

/** Secret values only travel renderer → main → OS keychain; nothing is ever read back. */
export function ClientProfileSecretRow({
  profileId,
  name,
  state,
  bitwardenRef,
  bitwardenUnlocked,
  readOnly
}: ClientProfileSecretRowProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<void>, done: string): Promise<void> => {
    setBusy(true)
    try {
      await action()
      setValue('')
      toast.success(done)
      await refreshClientProfiles()
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  const api = getClientProfilesApi()
  const save = (): Promise<void> =>
    run(
      async () => {
        await api?.setSecret({ profileId, name, value })
      },
      translate('aiborg.clientProfile.secret.saved', 'Saved to the OS keychain')
    )
  const remove = (): Promise<void> =>
    run(
      async () => {
        await api?.deleteSecret({ profileId, name })
      },
      translate('aiborg.clientProfile.secret.removed', 'Removed from the OS keychain')
    )
  const importFromBitwarden = (): Promise<void> =>
    run(
      async () => {
        const result = await api?.importSecretFromBitwarden({
          profileId,
          name
        })
        if (result && !result.ok) {
          throw new Error(result.message)
        }
      },
      translate('aiborg.clientProfile.secret.imported', 'Imported from Bitwarden')
    )

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <code className="font-mono text-xs">{name}</code>
        <Badge variant={state === 'set' ? 'secondary' : 'outline'}>{secretStateLabel(state)}</Badge>
      </div>
      {readOnly ? null : (
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={translate('aiborg.clientProfile.secret.pastePlaceholder', 'Paste value')}
            aria-label={translate('aiborg.clientProfile.secret.pasteLabel', 'Value for {{name}}', {
              name
            })}
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            size="sm"
            disabled={busy || value.length === 0}
            onClick={() => void save()}
          >
            {translate('aiborg.clientProfile.secret.save', 'Save')}
          </Button>
          {bitwardenRef && bitwardenUnlocked ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void importFromBitwarden()}
            >
              {translate('aiborg.clientProfile.secret.importBitwarden', 'Import from Bitwarden')}
            </Button>
          ) : null}
          {state === 'set' ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
            >
              {translate('aiborg.clientProfile.secret.remove', 'Remove')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
