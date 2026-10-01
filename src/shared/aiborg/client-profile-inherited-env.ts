import { CLIENT_PROFILE_IDENTITY_KEYS } from './client-profile-env-keys'

/**
 * H31: structured children inherit main's `process.env` under the launch env. When the launch
 * env carries a profile, its deleted keys (`AIBORG_PROFILE_UNSET`) must leave that layer too.
 */
export function stripClientProfileInheritedEnv<T extends Record<string, string | undefined>>(
  inherited: T,
  launchEnv: Record<string, string | undefined> | undefined,
  platform: NodeJS.Platform = process.platform
): T {
  const unset = launchEnv?.[CLIENT_PROFILE_IDENTITY_KEYS.id]
    ? launchEnv[CLIENT_PROFILE_IDENTITY_KEYS.unset]
    : undefined
  if (!unset) {
    return inherited
  }
  const fold = (key: string): string => (platform === 'win32' ? key.toUpperCase() : key)
  const drop = new Set(unset.split(' ').filter(Boolean).map(fold))
  const next = { ...inherited }
  for (const key of Object.keys(next)) {
    if (drop.has(fold(key))) {
      delete next[key]
    }
  }
  return next
}
