import type {
  AiborgClientProfilesApi,
  AiborgPreloadApi
} from '../../../preload/api/aiborg-client-profiles-api'

export type ClientProfilesBridge = AiborgClientProfilesApi

/** `window.aiborg` is absent in the web client and in tests; every caller treats null as "off". */
export function getClientProfilesApi(): ClientProfilesBridge | null {
  if (typeof window === 'undefined') {
    return null
  }
  const host: { aiborg?: Partial<AiborgPreloadApi> } = window
  return host.aiborg?.clientProfiles ?? null
}
