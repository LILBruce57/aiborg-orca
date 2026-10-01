// H60: a seam, so the Codex app-server client (also compiled into the CLI, which has no client
// profiles) needs no import of the main-only profile runtime.

type CodexTrustGrantInvocation = { env?: Record<string, string> }

/** Returns the env the grant child must run with, or undefined to keep the invocation's. */
type CodexTrustGrantGate = (
  invocation: CodexTrustGrantInvocation
) => Record<string, string> | undefined

let gate: CodexTrustGrantGate | null = null

/** Main installs the client-profile gate at startup (H22); null removes it. */
export function setClientProfileCodexTrustGrantGate(next: CodexTrustGrantGate | null): void {
  gate = next
}

/**
 * Throws when a client profile is active and the grant targets a home outside it; a grant in a
 * profile home gets that profile's full env instead of main's personal one.
 */
export function withClientProfileCodexTrustGrantEnv<T extends CodexTrustGrantInvocation>(
  invocation: T
): T {
  const env = gate?.(invocation)
  return env ? { ...invocation, env } : invocation
}
