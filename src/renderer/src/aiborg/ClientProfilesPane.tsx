import { useEffect, useState } from 'react'
import { FolderOpen, Plus, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type {
  BitwardenStatus,
  ClientProfileListEntry
} from '../../../shared/aiborg/client-profile-types'
import { getClientProfilesApi } from './client-profile-bridge'
import {
  applyClientProfilesState,
  retainClientProfileSync,
  useClientProfileStore
} from './client-profile-store'
import { ClientProfileCard } from './ClientProfileCard'
import { ClientProfileDeleteDialog } from './ClientProfileDeleteDialog'
import { NewClientProfileWizard } from './NewClientProfileWizard'

export function useBitwardenStatus(enabled: boolean): BitwardenStatus {
  const [status, setStatus] = useState<BitwardenStatus>('unavailable')
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void getClientProfilesApi()
      ?.getBitwardenStatus()
      .then((next) => {
        if (!cancelled) {
          setStatus(next)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [enabled])
  return status
}

async function chooseProfilesDir(): Promise<void> {
  const api = getClientProfilesApi()
  const dir = await window.api.repos.pickDirectory()
  if (!api || !dir) {
    return
  }
  applyClientProfilesState(await api.setProfilesDir({ dir }))
}

function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p role="alert" className="flex items-start gap-2 text-xs text-destructive">
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

export function ClientProfilesPane(): React.JSX.Element {
  const snapshot = useClientProfileStore((s) => s.snapshot)
  const loadError = useClientProfileStore((s) => s.loadError)
  const repos = useAppStore((s) => s.repos)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ClientProfileListEntry | null>(null)
  const bitwardenStatus = useBitwardenStatus(Boolean(snapshot?.enabled))
  useEffect(() => retainClientProfileSync(), [])

  const repoName = (repoId: string): string =>
    repos.find((repo) => repo.id === repoId)?.displayName ?? repoId
  const dirFromEnv = snapshot?.profilesDirSource === 'env'
  const canCreate = Boolean(snapshot?.enabled && snapshot.profilesDirWritable)

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {translate('aiborg.clientProfile.settings.folder', 'Profiles folder')}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'aiborg.clientProfile.settings.folderHelp',
              'Profile definitions (<id>.json) live outside this app, normally a clients folder in a private repository.'
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
            {snapshot?.profilesDir ??
              translate('aiborg.clientProfile.settings.folderUnset', 'Not set')}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={dirFromEnv}
            onClick={() =>
              void chooseProfilesDir().catch((error: unknown) =>
                toast.error(String(error instanceof Error ? error.message : error))
              )
            }
          >
            <FolderOpen />
            {translate('aiborg.clientProfile.settings.chooseFolder', 'Choose folder…')}
          </Button>
        </div>
        {dirFromEnv ? (
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'aiborg.clientProfile.settings.folderFromEnv',
              'Set by the AIBORG_PROFILES_DIR environment variable.'
            )}
          </p>
        ) : null}
        {snapshot?.profilesDirError ? <Notice>{snapshot.profilesDirError}</Notice> : null}
        {snapshot?.enabled && !snapshot.profilesDirWritable ? (
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'aiborg.clientProfile.settings.readOnly',
              'The folder is read-only, so profiles cannot be created or edited here.'
            )}
          </p>
        ) : null}
        {snapshot && !snapshot.keychainAvailable ? (
          <Notice>
            {translate(
              'aiborg.clientProfile.settings.keychainUnavailable',
              'The OS keychain is unavailable. Profiles cannot be activated until it works; secrets are never stored elsewhere.'
            )}
          </Notice>
        ) : null}
        {loadError ? <Notice>{loadError}</Notice> : null}
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {translate('aiborg.clientProfile.settings.profiles', 'Profiles')}
        </p>
        <Button type="button" size="sm" disabled={!canCreate} onClick={() => setWizardOpen(true)}>
          <Plus />
          {translate('aiborg.clientProfile.settings.newProfile', 'New profile')}
        </Button>
      </div>

      {snapshot?.enabled && snapshot.profiles.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {translate(
            'aiborg.clientProfile.settings.empty',
            'No profiles in this folder yet. Create one to separate a client’s credentials.'
          )}
        </p>
      ) : null}

      <div className="space-y-3">
        {(snapshot?.profiles ?? []).map((entry) => (
          <ClientProfileCard
            key={entry.id}
            entry={entry}
            isActive={snapshot?.activeProfileId === entry.id}
            repoNames={entry.boundRepoIds.map(repoName)}
            bitwardenUnlocked={bitwardenStatus === 'unlocked'}
            keychainAvailable={snapshot?.keychainAvailable ?? false}
            onDelete={setDeleteTarget}
          />
        ))}
      </div>

      <NewClientProfileWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        existingIds={(snapshot?.profiles ?? []).map((entry) => entry.id)}
        bitwardenStatus={bitwardenStatus}
      />
      <ClientProfileDeleteDialog
        entry={deleteTarget}
        profilesDirWritable={snapshot?.profilesDirWritable ?? false}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  )
}
