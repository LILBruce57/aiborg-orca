import { useEffect } from 'react'
import { AIBORG_BRAND } from '../../../shared/aiborg/brand'

export type ClientProfileIdentity = { id: string; name: string; color: string }

export function formatClientProfileDocumentTitle(profile: ClientProfileIdentity | null): string {
  return profile ? `${AIBORG_BRAND.productName} · ${profile.name}` : AIBORG_BRAND.productName
}

/** Header stripe colour and root attribute follow the active profile; returns the window title. */
export function applyClientProfileDocumentIdentity(
  root: HTMLElement,
  profile: ClientProfileIdentity | null
): string {
  if (profile) {
    root.dataset.aiborgProfile = profile.id
    // Why inline on <html>: inline custom properties beat theme-pack :root overrides.
    root.style.setProperty('--aiborg-profile', profile.color)
  } else {
    delete root.dataset.aiborgProfile
    root.style.removeProperty('--aiborg-profile')
  }
  return formatClientProfileDocumentTitle(profile)
}

export function useClientProfileDocumentIdentity(profile: ClientProfileIdentity | null): void {
  const id = profile?.id ?? null
  const name = profile?.name ?? null
  const color = profile?.color ?? null
  useEffect(() => {
    const identity = id !== null && name !== null && color !== null ? { id, name, color } : null
    document.title = applyClientProfileDocumentIdentity(document.documentElement, identity)
  }, [id, name, color])
}
