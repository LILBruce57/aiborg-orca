import type {
  ClientProfileOverviewErrorReason,
  ClientProfileOverviewResult
} from '../../../shared/aiborg/client-profile-overview-types'
import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { extractExecError, isMissingCommandBinaryError } from '../../git/exec-error'
import { ghExecFileAsync, type GhExecOptions } from '../../git/command-runner/gh-exec-file'
import { appendClientProfileAudit } from '../audit/client-profile-audit'
import { isClientProfileRefusalError } from '../binding/client-profile-refusal'
import {
  getActiveClientProfileId,
  getClientProfileById,
  isClientProfileSecretStored
} from '../binding/client-profile-core-access'
import {
  buildOverviewQuery,
  overviewEnvelopeSchema,
  parseOverviewResponse,
  redactOverviewDetail,
  type OverviewEnvelope
} from './client-profile-overview-query'
import {
  clientProfileOverviewRepoSignature,
  listClientProfileOverviewRepos
} from './client-profile-overview-repos'

export const CLIENT_PROFILE_OVERVIEW_TTL_MS = 5 * 60_000
const OVERVIEW_GH_TIMEOUT_MS = 30_000
const GH_TOKEN_SECRET_NAMES = ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN'] as const

export type OverviewGhRunner = (
  args: string[],
  options: GhExecOptions
) => Promise<{ stdout: string; stderr: string }>

export type ClientProfileOverviewDeps = {
  /** Defaults to the H29 gh runner, which injects the active profile's GH_TOKEN / GH_CONFIG_DIR. */
  runGh?: OverviewGhRunner
  now?: () => number
}

type OverviewSuccess = Extract<ClientProfileOverviewResult, { ok: true }>
type OverviewFailure = Extract<ClientProfileOverviewResult, { ok: false }>

const cache = new Map<string, { signature: string; result: OverviewSuccess }>()
const inFlight = new Map<string, Promise<ClientProfileOverviewResult>>()
// Why: a refresh that started before a forget (secret change, delete) must not re-cache old data.
let cacheGeneration = 0

const NOT_AUTHENTICATED_RE =
  /gh auth login|not logged in|authentication required|HTTP 401|bad credentials|requires authentication/i

function fail(
  profileId: string | null,
  reason: ClientProfileOverviewErrorReason,
  message: string
): OverviewFailure {
  return { ok: false, profileId, reason, message }
}

export function classifyClientProfileOverviewError(
  profileId: string,
  error: unknown
): OverviewFailure {
  if (isClientProfileRefusalError(error)) {
    return fail(profileId, 'profile-unavailable', redactOverviewDetail(error.message))
  }
  if (isMissingCommandBinaryError(error)) {
    return fail(profileId, 'gh-missing', 'The GitHub CLI (gh) is not installed or not on PATH.')
  }
  const { stderr } = extractExecError(error)
  const text = stderr || (error instanceof Error ? error.message : String(error))
  const blocked = typeof error === 'object' && error !== null && 'ghRateLimitBlocked' in error
  if (blocked || /rate limit/i.test(text)) {
    return fail(profileId, 'rate-limited', redactOverviewDetail(text))
  }
  if (NOT_AUTHENTICATED_RE.test(text)) {
    return fail(
      profileId,
      'not-authenticated',
      'gh is not logged in for this profile. Run gh auth login in a terminal of this profile, or store its GH_TOKEN.'
    )
  }
  return fail(profileId, 'failed', redactOverviewDetail(text))
}

/** A profile GH_TOKEN wins over any gh login, so a 401 then means the stored token is bad. */
function hasStoredGhToken(profile: ClientProfile): boolean {
  return GH_TOKEN_SECRET_NAMES.some(
    (name) => profile.secrets?.[name] !== undefined && isClientProfileSecretStored(profile.id, name)
  )
}

function classifyRefreshError(profile: ClientProfile, error: unknown): OverviewFailure {
  const failure = classifyClientProfileOverviewError(profile.id, error)
  if (failure.reason === 'not-authenticated' && hasStoredGhToken(profile)) {
    return fail(
      profile.id,
      'token-rejected',
      'GitHub rejected the stored GH_TOKEN of this profile. Replace it in Settings → Client profiles.'
    )
  }
  return failure
}

function parseEnvelope(stdout: string): OverviewEnvelope | null {
  try {
    const parsed = overviewEnvelopeSchema.safeParse(JSON.parse(stdout))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function runOverviewQuery(
  runGh: OverviewGhRunner,
  args: string[],
  host: string
): Promise<OverviewEnvelope> {
  // Why no cwd: the H29 runner then resolves the active profile, never a repo's.
  // Why not idempotent: every retry re-resolves the *active* profile's env, so a switch during
  // the backoff would run this profile's query with another profile's token. Refresh retries.
  const options: GhExecOptions = { host, idempotent: false, timeout: OVERVIEW_GH_TIMEOUT_MS }
  try {
    const { stdout } = await runGh(args, options)
    return overviewEnvelopeSchema.parse(JSON.parse(stdout))
  } catch (error) {
    // GraphQL partial errors (one repo unreadable) exit non-zero with the data on stdout.
    const envelope = parseEnvelope(extractExecError(error).stdout)
    if (envelope?.data && Object.keys(envelope.data).length > 0) {
      return envelope
    }
    throw error
  }
}

function itemCount(result: ClientProfileOverviewResult): number {
  return result.ok
    ? result.orgs.reduce(
        (sum, org) =>
          sum +
          org.pullRequests.length +
          org.reviewRequests.length +
          org.issues.length +
          org.branches.length,
        0
      )
    : 0
}

async function fetchOverview(
  profile: ClientProfile,
  signature: string,
  deps: ClientProfileOverviewDeps
): Promise<{ result: ClientProfileOverviewResult; repoCount: number }> {
  const { host, allowedOrgs } = profile.github
  const generation = cacheGeneration
  const { repos, truncated } = listClientProfileOverviewRepos(profile)
  const args = ['api', 'graphql', '-f', `query=${buildOverviewQuery(allowedOrgs, repos)}`]
  try {
    const envelope = await runOverviewQuery(deps.runGh ?? ghExecFileAsync, args, host)
    if (getActiveClientProfileId() !== profile.id) {
      const message = 'The active client profile changed; refresh again.'
      return { result: fail(profile.id, 'profile-changed', message), repoCount: repos.length }
    }
    const parsed = parseOverviewResponse(envelope, allowedOrgs, repos, host)
    const success: OverviewSuccess = {
      ok: true,
      profileId: profile.id,
      host,
      viewerLogin: parsed.viewerLogin,
      fetchedAt: (deps.now ?? Date.now)(),
      cached: false,
      orgs: parsed.orgs,
      repoCount: repos.length,
      partial: parsed.partial,
      reposTruncated: truncated,
      problem: parsed.problem,
      rateLimitMessage: null
    }
    if (generation === cacheGeneration) {
      cache.set(profile.id, { signature, result: success })
    }
    return { result: success, repoCount: repos.length }
  } catch (error) {
    return { result: classifyRefreshError(profile, error), repoCount: repos.length }
  }
}

async function refresh(
  profile: ClientProfile,
  signature: string,
  deps: ClientProfileOverviewDeps
): Promise<ClientProfileOverviewResult> {
  const { result, repoCount } = await fetchOverview(profile, signature, deps)
  appendClientProfileAudit(profile.id, 'github.overview.refresh', {
    host: profile.github.host,
    orgs: profile.github.allowedOrgs.join(' '),
    repos: repoCount,
    outcome: result.ok ? 'ok' : result.reason,
    items: itemCount(result)
  })
  // Why: a forced refresh that hits the limit keeps the last good answer on screen.
  const last = cache.get(profile.id)
  if (!result.ok && result.reason === 'rate-limited' && last?.signature === signature) {
    return { ...last.result, cached: true, rateLimitMessage: result.message }
  }
  return result
}

/**
 * The active profile's GitHub overview (design §8 Phase 4). Cached per profile for 5 minutes to
 * respect gh rate limits; `force` skips the cache. One audit line per actual refresh.
 */
export function getClientProfileOverview(
  options: { force?: boolean } = {},
  deps: ClientProfileOverviewDeps = {}
): Promise<ClientProfileOverviewResult> {
  const profileId = getActiveClientProfileId()
  if (!profileId) {
    return Promise.resolve(fail(null, 'no-active-profile', 'No client profile is active.'))
  }
  const profile = getClientProfileById(profileId)
  if (!profile) {
    return Promise.resolve(
      fail(profileId, 'profile-unavailable', `Client profile "${profileId}" is missing or invalid.`)
    )
  }
  // Why a signature: editing allowedOrgs or adding a repo must not serve the old answer. Cheap
  // inputs only; the git-config repo scan runs on a cache miss.
  const signature = JSON.stringify([
    profile.github.host,
    profile.github.allowedOrgs,
    clientProfileOverviewRepoSignature()
  ])
  const cached = cache.get(profileId)
  const now = (deps.now ?? Date.now)()
  if (
    !options.force &&
    cached?.signature === signature &&
    now - cached.result.fetchedAt < CLIENT_PROFILE_OVERVIEW_TTL_MS
  ) {
    return Promise.resolve({ ...cached.result, cached: true })
  }
  const key = `${profileId}|${signature}`
  const pending = inFlight.get(key)
  if (pending) {
    return pending
  }
  const request = refresh(profile, signature, deps).finally(() => inFlight.delete(key))
  inFlight.set(key, request)
  return request
}

/** After a secret change, a gh login or a delete: the old answer may belong to another account. */
export function forgetClientProfileOverview(profileId?: string): void {
  cacheGeneration++
  if (profileId === undefined) {
    cache.clear()
  } else {
    cache.delete(profileId)
  }
}

export function resetClientProfileOverviewForTests(): void {
  cache.clear()
  inFlight.clear()
}
