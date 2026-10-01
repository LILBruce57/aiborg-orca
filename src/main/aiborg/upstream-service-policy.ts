/**
 * AI-Borg switches for upstream Orca services. Each upstream call site gets a one-line hook into
 * this module (see docs/aiborg/PATCHES.md), so flipping a switch here is the only change needed.
 */

// Why off: the only feed is upstream's (github.com/stablyai/orca), which would replace AI-Borg
// with stock Orca. Covers background checks, menu checks, the onorca.dev nudge and build lists.
export const AIBORG_UPDATES_DISABLED = true

// Why off: feedback and crash reports post diagnostic bundles (repo paths, names) to onorca.dev.
export const AIBORG_FEEDBACK_DISABLED = true

// Why off: the star check/PUT would run with whatever gh account is active, including a client's.
export const AIBORG_UPSTREAM_STAR_DISABLED = true

// Why off: registering or removing `orca` globally would replace or delete a side-by-side stock
// Orca's command (macOS symlink reclaim, WSL launcher repair, "stale" removal). AI-Borg terminals
// already put this app's CLI on PATH.
export const AIBORG_GLOBAL_CLI_REGISTRATION_DISABLED = true

// Why off: share.onorca.dev publishes artifacts and skills as public links, and agents can trigger
// it through the `orca` CLI, so client content could leave the machine.
export const AIBORG_CLOUD_SHARING_DISABLED = true

// Why off: push.onorca.dev relays notification text (terminal and agent output) to paired phones.
export const AIBORG_PUSH_RELAY_DISABLED = true

/**
 * Why: upstream's own suites must keep asserting upstream behaviour so monthly merges stay
 * conflict-free. Only Vitest plus config/aiborg/vitest-upstream-behavior-setup.ts sets both
 * variables; the AI-Borg suites clear the second one. Mirrored in config/aiborg/upstream-behavior-seam.cjs.
 */
export function isUpstreamBehaviorUnderTest(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITEST === 'true' && env.AIBORG_UPSTREAM_BEHAVIOR_IN_TESTS === '1'
}

function isSwitchedOff(aiborgDisabled: boolean): boolean {
  return aiborgDisabled && !isUpstreamBehaviorUnderTest()
}

/** Brand data at an upstream call site; upstream suites keep seeing the upstream value. */
export function brandedOrUpstream<T>(aiborgValue: T, upstreamValue: T): T {
  return isUpstreamBehaviorUnderTest() ? upstreamValue : aiborgValue
}

export function isAiborgAutoUpdateDisabled(): boolean {
  return isSwitchedOff(AIBORG_UPDATES_DISABLED)
}

export function isAiborgUpstreamStarDisabled(): boolean {
  return isSwitchedOff(AIBORG_UPSTREAM_STAR_DISABLED)
}

export function isAiborgGlobalCliRegistrationDisabled(): boolean {
  return isSwitchedOff(AIBORG_GLOBAL_CLI_REGISTRATION_DISABLED)
}

export function isAiborgPushRelayDisabled(): boolean {
  return isSwitchedOff(AIBORG_PUSH_RELAY_DISABLED)
}

export function assertAiborgFeedbackAllowed(): void {
  if (isSwitchedOff(AIBORG_FEEDBACK_DISABLED)) {
    throw new Error('Sending feedback to the Orca team is disabled in AI-Borg.')
  }
}

export function assertAiborgGlobalCliRegistrationAllowed(): void {
  if (isAiborgGlobalCliRegistrationDisabled()) {
    throw new Error(
      'AI-Borg does not register or remove a global `orca` command, so stock Orca’s stays untouched. Terminals inside AI-Borg already have it on PATH.'
    )
  }
}

export function assertAiborgCloudSharingAllowed(): void {
  if (isSwitchedOff(AIBORG_CLOUD_SHARING_DISABLED)) {
    throw new Error('Sharing artifacts and skills through Orca’s cloud is disabled in AI-Borg.')
  }
}
