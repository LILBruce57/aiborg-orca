import { resolveConfiguredGitPushTarget } from '../../../shared/git-push-target-resolution'
import type { GitPushTarget } from '../../../shared/worktree/types'
import {
  assertPushAllowed,
  resolveGuardProfile,
  type RunGitForPushGuard
} from '../git/assert-push-allowed'

/** H50/H51: the remote a local push resolved to, checked before `git push` runs. */
export function assertClientProfilePushTarget(
  worktreePath: string,
  remote: string | undefined,
  runGit: RunGitForPushGuard
): Promise<void> {
  return assertPushAllowed(worktreePath, remote ?? 'origin', runGit)
}

/**
 * H52: SSH pushes run on the remote host, so the push URL is read there through the provider.
 * Without an explicit target the provider pushes to the configured upstream, else origin.
 * Personal mode returns before any remote round trip.
 */
export async function assertClientProfileSshPush(
  provider: {
    exec: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>
  },
  worktreePath: string,
  pushTarget: GitPushTarget | undefined
): Promise<void> {
  const profile = resolveGuardProfile(worktreePath)
  if (!profile) {
    return
  }
  const runGit: RunGitForPushGuard = (args) => provider.exec(args, worktreePath)
  const remote =
    pushTarget?.remoteName ?? (await resolveConfiguredGitPushTarget(runGit))?.remote ?? 'origin'
  await assertPushAllowed(worktreePath, remote, runGit, profile)
}
