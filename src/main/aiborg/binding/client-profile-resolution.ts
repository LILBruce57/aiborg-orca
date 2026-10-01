import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../../../shared/worktree/id'
import type { Repo } from '../../../shared/repo-types'
import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { getClientProfileRuntime } from '../profiles/client-profile-runtime'
import {
  forgetRemoteOwnerCache,
  readRepoRemoteOwners,
  type HostedRemoteOwner
} from './client-profile-remote-owner'
import { findGitCommonDir } from './client-profile-git-dir'
import {
  getActiveClientProfileId,
  getClientProfileById,
  getClientProfilePtyBinding,
  getClientProfileRepoBindings,
  hasClientProfilesConfigured,
  listClientProfilesClaimingOwner
} from './client-profile-core-access'

/** The repo fields resolution reads. */
export type ClientProfileRepo = Pick<Repo, 'id' | 'path' | 'connectionId'>

/** The store slice resolution reads; satisfied by the app's and orcad's `Store`. */
export type ClientProfileRepoSource = {
  getRepo: (id: string) => ClientProfileRepo | undefined
  getRepos: () => readonly ClientProfileRepo[]
  getAllWorktreeMeta: () => Record<string, unknown>
}

type ResolutionHost = { kind: 'app' | 'orcad'; repos: ClientProfileRepoSource }

let host: ResolutionHost | null = null

const EMPTY_REPOS: ClientProfileRepoSource = {
  getRepo: () => undefined,
  getRepos: () => [],
  getAllWorktreeMeta: () => ({})
}

/** H22: set once per process by client-profile-wiring; orcad hosts refuse profile-bound work. */
export function setClientProfileRepoSource(
  kind: 'app' | 'orcad',
  repos: ClientProfileRepoSource
): void {
  host = { kind, repos }
}

export function isClientProfileRefusingHost(): boolean {
  return host?.kind === 'orcad' || getClientProfileRuntime()?.mode === 'orcad'
}

export type ClientProfileResolutionSource = 'pty' | 'repo-binding' | 'org' | 'active' | 'personal'

export type ClientProfileResolution = {
  /** Null in personal mode. Set but unloaded (`profile: null`) means the spawn must refuse. */
  profileId: string | null
  profile: ClientProfile | null
  source: ClientProfileResolutionSource
  repoId: string | null
  /** Other profiles whose orgs the repo's remotes also name; the repo is then refused. */
  conflictingProfileIds?: string[]
}

const PERSONAL: ClientProfileResolution = {
  profileId: null,
  profile: null,
  source: 'personal',
  repoId: null
}

function resolution(
  profileId: string | null,
  source: ClientProfileResolutionSource,
  repoId: string | null
): ClientProfileResolution {
  if (!profileId) {
    return { ...PERSONAL, repoId }
  }
  return { profileId, profile: getClientProfileById(profileId), source, repoId }
}

function activeResolution(repoId: string | null): ClientProfileResolution {
  return resolution(getActiveClientProfileId(), 'active', repoId)
}

function claimsFor(owners: readonly HostedRemoteOwner[]): string[] {
  const ids = new Set<string>()
  for (const owner of owners) {
    listClientProfilesClaimingOwner(owner.host, owner.owner).forEach((id) => ids.add(id))
  }
  return [...ids].sort()
}

/**
 * Profile files (valid or not) claiming the repo. `origin` decides when it names a client, so a
 * client fork of an OSS repo stays the client's; otherwise any other remote's client claims it.
 */
function claimingProfileIds(repo: ClientProfileRepo): string[] {
  // SSH repos live on another host; only an explicit binding can attribute them.
  if (repo.connectionId) {
    return []
  }
  const owners = readRepoRemoteOwners(repo.path)
  const byOrigin = claimsFor(owners.origin)
  return byOrigin.length > 0 ? byOrigin : claimsFor(owners.others)
}

/**
 * Repo → profile: explicit `repoBindings` first, then the owners of its remotes' push URLs.
 * A match on an invalid profile file, or on two profiles, resolves with `profile: null` so
 * callers refuse instead of falling back to the personal account (fail closed).
 */
export function resolveRepoClientProfile(repo: ClientProfileRepo): ClientProfileResolution {
  const bound = getClientProfileRepoBindings()[repo.id]
  if (bound) {
    return resolution(bound, 'repo-binding', repo.id)
  }
  const [matched, ...others] = claimingProfileIds(repo)
  if (!matched) {
    return activeResolution(repo.id)
  }
  const resolved = resolution(matched, 'org', repo.id)
  return others.length > 0
    ? { ...resolved, profile: null, conflictingProfileIds: others }
    : resolved
}

/**
 * Worktree → repo → profile (design §4.1). Unbound repos, folder workspaces and floating
 * terminals follow the active profile.
 */
export function resolveWorktreeClientProfile(
  worktreeId: string | null | undefined
): ClientProfileResolution {
  if (!hasClientProfilesConfigured()) {
    return PERSONAL
  }
  const repo = worktreeId ? host?.repos.getRepo(getRepoIdFromWorktreeId(worktreeId)) : undefined
  return repo ? resolveRepoClientProfile(repo) : activeResolution(null)
}

function findKnownRepoForCwd(
  cwd: string,
  repos: ClientProfileRepoSource
): ClientProfileRepo | null {
  const candidates: { repoId: string; path: string }[] = repos
    .getRepos()
    .map((repo) => ({ repoId: repo.id, path: repo.path }))
  for (const worktreeId of Object.keys(repos.getAllWorktreeMeta())) {
    const parsed = splitWorktreeId(worktreeId)
    if (parsed) {
      candidates.push({ repoId: parsed.repoId, path: parsed.worktreePath })
    }
  }
  let bestRepo: ClientProfileRepo | null = null
  let bestLength = -1
  for (const candidate of candidates) {
    if (candidate.path.length <= bestLength || !isPathInsideOrEqual(candidate.path, cwd)) {
      continue
    }
    const repo = repos.getRepo(candidate.repoId)
    if (repo) {
      bestRepo = repo
      bestLength = candidate.path.length
    }
  }
  return bestRepo
}

const COMMON_DIR_TTL_MS = 30_000
const commonDirCache = new Map<string, { value: string | null; readAt: number }>()

function cachedCommonDir(path: string): string | null {
  const cached = commonDirCache.get(path)
  if (cached && Date.now() - cached.readAt < COMMON_DIR_TTL_MS) {
    return cached.value
  }
  const value = findGitCommonDir(path)
  commonDirCache.set(path, { value, readAt: Date.now() })
  return value
}

function sameDir(a: string, b: string): boolean {
  return isPathInsideOrEqual(a, b) && isPathInsideOrEqual(b, a)
}

/**
 * Worktrees Orca did not create (`git worktree add` in a terminal or by an agent, or under
 * ~/orca/workspaces) sit outside every known path: match them by their shared git dir.
 */
function findRepoByCommonDir(
  cwd: string,
  repos: ClientProfileRepoSource
): ClientProfileRepo | null {
  const common = cachedCommonDir(cwd)
  if (!common) {
    return null
  }
  return (
    repos.getRepos().find((repo) => {
      const repoCommon = repo.connectionId ? null : cachedCommonDir(repo.path)
      return repoCommon !== null && sameDir(repoCommon, common)
    }) ?? null
  )
}

/** The repo `cwd` belongs to: longest known repo/worktree path, else the same git common dir. */
export function findRepoForCwd(cwd: string): ClientProfileRepo | null {
  if (!host) {
    return null
  }
  return findKnownRepoForCwd(cwd, host.repos) ?? findRepoByCommonDir(cwd, host.repos)
}

/** cwd → profile for Orca's own git/gh and scripts. Unknown cwd gets no profile. */
export function resolveCwdClientProfile(cwd: string | null | undefined): ClientProfileResolution {
  if (!cwd || !hasClientProfilesConfigured()) {
    return PERSONAL
  }
  const repo = findRepoForCwd(cwd)
  return repo ? resolveRepoClientProfile(repo) : PERSONAL
}

/** Owners of every remote of the repo `cwd` belongs to (gh's base repo can be any of them). */
export function listCwdRemoteOwners(cwd: string): string[] {
  const repo = findRepoForCwd(cwd)
  if (!repo || repo.connectionId) {
    return []
  }
  const owners = readRepoRemoteOwners(repo.path)
  return [...new Set([...owners.origin, ...owners.others].map((owner) => owner.owner))]
}

/** For calls with no repo (gh viewer/global queries, usage readers): the active profile. */
export function resolveActiveClientProfile(): ClientProfileResolution {
  return hasClientProfilesConfigured() ? activeResolution(null) : PERSONAL
}

/** A known profile id (a PTY pin, a profile-owned account home) as a resolution. */
export function resolveClientProfileById(
  profileId: string,
  source: ClientProfileResolutionSource
): ClientProfileResolution {
  return resolution(profileId, source, null)
}

/** The profile a repo belongs to (§1.2): its binding, else its remotes' owners, else none. */
export function resolveRepoClientProfileId(repo: ClientProfileRepo): string | null {
  if (!hasClientProfilesConfigured()) {
    return null
  }
  const resolved = resolveRepoClientProfile(repo)
  return resolved.source === 'repo-binding' || resolved.source === 'org' ? resolved.profileId : null
}

/** Same, by repo id, for the renderer's mismatch warning. */
export function resolveRepoIdClientProfileId(repoId: string): string | null {
  const repo = host?.repos.getRepo(repoId)
  return repo ? resolveRepoClientProfileId(repo) : null
}

/** The profile a PTY (or daemon session id) was spawned under. */
export function getPtyClientProfileBinding(ptyOrSessionId: string): string | null {
  return getClientProfilePtyBinding(ptyOrSessionId)
}

/** Every repo the host knows (the app's Store); the overview filters them per profile. */
export function listKnownClientProfileRepos(): readonly ClientProfileRepo[] {
  return host?.repos.getRepos() ?? []
}

/** Repo source for hosts without a Store (tests, scripts): a plain list of known repos. */
export function registerClientProfileRepoLookup(lookup: () => readonly ClientProfileRepo[]): void {
  setClientProfileRepoSource(host?.kind ?? 'app', {
    getRepo: (id) => lookup().find((repo) => repo.id === id),
    getRepos: lookup,
    getAllWorktreeMeta: () => ({})
  })
}

/** Switches the current host to orcad semantics (profile-bound work refused). */
export function installOrcadClientProfileResolver(): void {
  host = host ? { ...host, kind: 'orcad' } : { kind: 'orcad', repos: EMPTY_REPOS }
}

export function resetClientProfileResolutionForTests(): void {
  host = null
  forgetRemoteOwnerCache()
  commonDirCache.clear()
}
