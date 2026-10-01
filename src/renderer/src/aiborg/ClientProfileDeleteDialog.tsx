import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import type { ClientProfileListEntry } from '../../../shared/aiborg/client-profile-types'
import { getClientProfilesApi } from './client-profile-bridge'
import { applyClientProfilesState } from './client-profile-store'
import { buildRevokeChecklist, type RevokeChecklistItem } from './client-profile-revoke-checklist'

type ClientProfileDeleteDialogProps = {
  entry: ClientProfileListEntry | null
  profilesDirWritable: boolean
  onClose: () => void
}

function RevokeChecklist({ items }: { items: RevokeChecklistItem[] }): React.JSX.Element {
  const [done, setDone] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string, checked: boolean): void => {
    setDone((previous) => {
      const next = new Set(previous)
      if (checked) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return next
    })
  }
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-2 text-sm">
          <Checkbox
            id={`aiborg-revoke-${item.id}`}
            checked={done.has(item.id)}
            onCheckedChange={(checked) => toggle(item.id, checked === true)}
          />
          <Label htmlFor={`aiborg-revoke-${item.id}`} className="min-w-0 flex-1">
            {item.label}
          </Label>
          {item.url ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void window.api.shell.openUrl(item.url ?? '')}
            >
              <ExternalLink />
              {translate('aiborg.clientProfile.revoke.open', 'Open')}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export function ClientProfileDeleteDialog({
  entry,
  profilesDirWritable,
  onClose
}: ClientProfileDeleteDialogProps): React.JSX.Element {
  const [typedId, setTypedId] = useState('')
  const [deleteJson, setDeleteJson] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revokeItems, setRevokeItems] = useState<RevokeChecklistItem[] | null>(null)

  const close = (): void => {
    setTypedId('')
    setDeleteJson(false)
    setError(null)
    setRevokeItems(null)
    onClose()
  }

  const submit = async (): Promise<void> => {
    const api = getClientProfilesApi()
    if (!entry || !api) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api.deleteProfile({
        profileId: entry.id,
        confirmId: typedId,
        deleteJson
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      applyClientProfilesState(result.state)
      setRevokeItems(buildRevokeChecklist(entry.profile))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const name = entry?.profile?.name ?? entry?.id ?? ''
  return (
    <Dialog open={entry !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent>
        {revokeItems ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {translate(
                  'aiborg.clientProfile.delete.revokeTitle',
                  'Revoke access at the client'
                )}
              </DialogTitle>
              <DialogDescription>
                {translate(
                  'aiborg.clientProfile.delete.revokeBody',
                  'Local files, keychain items and bindings for {{name}} are gone. These credentials still work until you revoke them.',
                  { name }
                )}
              </DialogDescription>
            </DialogHeader>
            <RevokeChecklist items={revokeItems} />
            <DialogFooter>
              <Button type="button" onClick={close}>
                {translate('aiborg.clientProfile.delete.done', 'Done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {translate('aiborg.clientProfile.delete.title', 'Delete {{name}}?', { name })}
              </DialogTitle>
              <DialogDescription>
                {translate(
                  'aiborg.clientProfile.delete.body',
                  'Removes the profile folder (logins, SSH key, gitconfig), its keychain secrets and its repository and terminal bindings. The audit log is archived. Close its terminals first.'
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="aiborg-delete-confirm">
                {translate('aiborg.clientProfile.delete.typeId', 'Type {{id}} to confirm', {
                  id: entry?.id ?? ''
                })}
              </Label>
              <Input
                id="aiborg-delete-confirm"
                autoComplete="off"
                spellCheck={false}
                value={typedId}
                onChange={(event) => setTypedId(event.target.value)}
              />
              <div className="flex items-center gap-2 pt-1">
                <Checkbox
                  id="aiborg-delete-json"
                  checked={deleteJson}
                  disabled={!profilesDirWritable}
                  onCheckedChange={(checked) => setDeleteJson(checked === true)}
                />
                <Label htmlFor="aiborg-delete-json">
                  {translate(
                    'aiborg.clientProfile.delete.deleteJson',
                    'Also delete {{id}}.json from the profiles folder',
                    { id: entry?.id ?? '' }
                  )}
                </Label>
              </div>
              {error ? (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                {translate('aiborg.clientProfile.delete.cancel', 'Cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={busy || typedId !== entry?.id}
                onClick={() => void submit()}
              >
                {translate('aiborg.clientProfile.delete.confirm', 'Delete profile')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
