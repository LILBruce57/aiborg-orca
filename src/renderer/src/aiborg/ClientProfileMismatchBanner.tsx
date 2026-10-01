import { useEffect } from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getClientProfilesApi } from './client-profile-bridge'
import {
  applyClientProfilesState,
  clientProfileDisplayName,
  ensureRepoProfileResolved,
  findClientProfileIdForRepo,
  retainClientProfileSync,
  switchClientProfile,
  useClientProfileStore
} from './client-profile-store'
import {
  checkClientProfileForWorktree,
  clearPendingClientProfileMismatch,
  findClientProfileMismatch,
  markWorktreeReadOnly,
  useClientProfileMismatchStore,
  type ClientProfileMismatch
} from './check-client-profile-for-worktree'

function reportError(error: unknown): void {
  toast.error(translate('aiborg.clientProfile.mismatch.failed', 'Client profile action failed'), {
    description: error instanceof Error ? error.message : String(error)
  })
}

function useMismatchDialog(): void {
  const confirm = useConfirmationDialog()
  const pending = useClientProfileMismatchStore((s) => s.pending)

  useEffect(() => {
    if (!pending) {
      return
    }
    const snapshot = useClientProfileStore.getState().snapshot
    const repoName = clientProfileDisplayName(snapshot, pending.repoProfileId)
    const activeName = pending.activeProfileId
      ? clientProfileDisplayName(snapshot, pending.activeProfileId)
      : translate('aiborg.clientProfile.chip.personal', 'Personal')
    const api = getClientProfilesApi()
    const record = (event: 'repo.mismatch.shown' | 'repo.mismatch.override'): void => {
      void api
        ?.recordMismatch({
          profileId: pending.repoProfileId,
          worktreeId: pending.worktreeId,
          event
        })
        .catch(() => undefined)
    }
    record('repo.mismatch.shown')
    void confirm({
      title: translate(
        'aiborg.clientProfile.mismatch.dialogTitle',
        'This repository belongs to {{name}}',
        {
          name: repoName
        }
      ),
      description: translate(
        'aiborg.clientProfile.mismatch.dialogBody',
        'You are working as {{active}}. Terminals and agents for this repository only start under {{name}}.',
        { active: activeName, name: repoName }
      ),
      icon: TriangleAlert,
      confirmLabel: translate('aiborg.clientProfile.mismatch.switchTo', 'Switch to {{name}}', {
        name: repoName
      }),
      cancelLabel: translate(
        'aiborg.clientProfile.mismatch.readOnly',
        'Open read-only (no terminals)'
      ),
      initialFocus: 'confirm'
    }).then((switchProfile) => {
      if (switchProfile) {
        clearPendingClientProfileMismatch()
        void switchClientProfile(pending.repoProfileId).catch(reportError)
      } else {
        markWorktreeReadOnly(pending.worktreeId)
        record('repo.mismatch.override')
      }
    })
  }, [confirm, pending])
}

function MismatchStrip({ mismatch }: { mismatch: ClientProfileMismatch }): React.JSX.Element {
  const snapshot = useClientProfileStore((s) => s.snapshot)
  const name = clientProfileDisplayName(snapshot, mismatch.repoProfileId)
  return (
    <section
      role="status"
      className="flex shrink-0 items-center gap-2 border-t border-destructive/50 bg-card px-3 py-1.5 text-xs text-foreground"
    >
      <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate">
        {translate(
          'aiborg.clientProfile.mismatch.banner',
          'This repository belongs to client profile {{name}}. Terminals stay closed until you switch.',
          { name }
        )}
      </p>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => void switchClientProfile(mismatch.repoProfileId).catch(reportError)}
      >
        {translate('aiborg.clientProfile.mismatch.switchTo', 'Switch to {{name}}', { name })}
      </Button>
    </section>
  )
}

function UnboundStrip({
  repoId,
  activeProfileId
}: {
  repoId: string
  activeProfileId: string
}): React.JSX.Element {
  const snapshot = useClientProfileStore((s) => s.snapshot)
  const name = clientProfileDisplayName(snapshot, activeProfileId)
  const bind = async (): Promise<void> => {
    const api = getClientProfilesApi()
    if (api) {
      applyClientProfilesState(await api.bindRepo({ repoId, profileId: activeProfileId }))
    }
  }
  return (
    <section
      role="status"
      className="flex shrink-0 items-center gap-2 border-t border-border bg-card px-3 py-1.5 text-xs text-muted-foreground"
    >
      <Info className="size-3.5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate">
        {translate('aiborg.clientProfile.unbound.banner', 'Not bound to a client profile.')}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => void bind().catch(reportError)}
      >
        {translate('aiborg.clientProfile.unbound.bind', 'Bind to {{name}}', {
          name
        })}
      </Button>
    </section>
  )
}

/** Bottom strip of the centre column (H40) plus the host of the repo-mismatch dialog (H53). */
export function ClientProfileMismatchBanner(): React.JSX.Element | null {
  const snapshot = useClientProfileStore((s) => s.snapshot)
  const resolved = useClientProfileStore((s) => s.resolvedRepoProfiles)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repos = useAppStore((s) => s.repos)
  useEffect(() => retainClientProfileSync(), [])
  useMismatchDialog()
  // H53: every activation path ends in activeWorktreeId, so one watcher replaces per-entry-point calls in core.
  useEffect(() => {
    if (activeWorktreeId) {
      checkClientProfileForWorktree(activeWorktreeId)
    }
  }, [activeWorktreeId])
  const repoId = activeWorktreeId ? getRepoIdFromWorktreeId(activeWorktreeId) : null
  useEffect(() => {
    if (repoId) {
      void ensureRepoProfileResolved(repoId).catch(() => undefined)
    }
  }, [repoId, snapshot])

  if (!snapshot?.enabled || !activeWorktreeId || !repoId) {
    return null
  }
  const mismatch = findClientProfileMismatch(snapshot, activeWorktreeId, resolved)
  if (mismatch) {
    return <MismatchStrip mismatch={mismatch} />
  }
  const isRepo = repos.some((repo) => repo.id === repoId)
  if (
    snapshot.activeProfileId &&
    isRepo &&
    !findClientProfileIdForRepo(snapshot, repoId, resolved)
  ) {
    return <UnboundStrip repoId={repoId} activeProfileId={snapshot.activeProfileId} />
  }
  return null
}
