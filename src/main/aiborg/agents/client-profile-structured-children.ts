import { CLIENT_PROFILE_IDENTITY_KEYS } from '../../../shared/aiborg/client-profile-env-keys'

type ExitObservable = {
  once(event: 'exit' | 'close', listener: () => void): unknown
}

const liveByProfile = new Map<string, number>()

/**
 * H31d: structured Claude/Codex children started under a profile, so deleting it waits for them
 * (they hold its secrets in their env and write to P while P would be wiped underneath them).
 */
export function trackClientProfileStructuredChild(
  launchEnv: Record<string, string | undefined> | undefined,
  child: ExitObservable | null | undefined
): void {
  const profileId = launchEnv?.[CLIENT_PROFILE_IDENTITY_KEYS.id]?.trim()
  if (!profileId || typeof child?.once !== 'function') {
    return
  }
  liveByProfile.set(profileId, (liveByProfile.get(profileId) ?? 0) + 1)
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    const remaining = (liveByProfile.get(profileId) ?? 1) - 1
    if (remaining > 0) {
      liveByProfile.set(profileId, remaining)
    } else {
      liveByProfile.delete(profileId)
    }
  }
  // Why close too: a child that never started emits error + close but no exit.
  child.once('exit', release)
  child.once('close', release)
}

export function hasLiveClientProfileStructuredChild(profileId: string): boolean {
  return (liveByProfile.get(profileId) ?? 0) > 0
}

export function resetClientProfileStructuredChildrenForTests(): void {
  liveByProfile.clear()
}
