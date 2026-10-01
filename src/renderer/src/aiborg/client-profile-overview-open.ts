/** The chip owns the overview sheet; the chip menu and Cmd+J open it through this event. */
export const CLIENT_PROFILE_OVERVIEW_OPEN_EVENT = 'aiborg:client-profile-overview-open'

export function openClientProfileOverview(): void {
  window.dispatchEvent(new Event(CLIENT_PROFILE_OVERVIEW_OPEN_EVENT))
}
