import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { getClientProfileLayout } from './client-profile-core-access'

export type StructuredAgentKind = 'claude' | 'codex'

export function accountHomesEqual(left: string | null | undefined, right: string): boolean {
  return (
    typeof left === 'string' &&
    normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
  )
}

/** The home a session under this profile must pin: `P/claude` or `P/codex`. */
export function clientProfileAgentHome(profileId: string, agent: StructuredAgentKind): string {
  const layout = getClientProfileLayout(profileId)
  return agent === 'claude' ? layout.claude : layout.codex
}
