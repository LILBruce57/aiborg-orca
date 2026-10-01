import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import type { InactiveClaudeAccount } from './claude-managed-account-credentials'
import { fetchInactiveClaudeAccountUsage } from './claude-managed-account-usage'
import type {
  ClaudeManagedAccountUsageOptions,
  ClaudeRateLimitFetchOptions
} from './claude-usage-fetch-options'
import { clientProfileClaudeUsageHidden } from '../aiborg/agents/client-profile-usage'

export type FetchClaudeRateLimitsOptions = ClaudeRateLimitFetchOptions
export type FetchManagedAccountUsageOptions = ClaudeManagedAccountUsageOptions
export type InactiveClaudeAccountInfo = InactiveClaudeAccount

export async function fetchClaudeRateLimits(
  options?: FetchClaudeRateLimitsOptions
): Promise<ProviderRateLimits> {
  // AI-Borg (H60): hidden under a client profile instead of reading the personal login.
  return clientProfileClaudeUsageHidden() ?? fetchActiveClaudeRateLimits(options)
}

export async function fetchManagedAccountUsage(
  account: InactiveClaudeAccountInfo,
  options: FetchManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  // AI-Borg (H60): managed accounts are off under a client profile.
  return clientProfileClaudeUsageHidden() ?? fetchInactiveClaudeAccountUsage(account, options)
}
