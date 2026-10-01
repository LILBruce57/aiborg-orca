import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { findGitCommonDir, parseGitConfigRemotePushUrls } from '../binding/client-profile-git-dir'
import { getClientProfileRepoBindings } from '../binding/client-profile-core-access'
import {
  listKnownClientProfileRepos,
  resolveRepoClientProfileId
} from '../binding/client-profile-resolution'
import { parseRemoteOwner } from '../git/client-profile-remote-owner'
import type { OverviewRepoRef } from './client-profile-overview-query'

/** Caps the GraphQL query; the overview is a glance, not a repo browser. */
export const OVERVIEW_MAX_REPOS = 10

const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/

/** `origin`'s push URL as host/owner/name, read from git config without spawning git. */
function readOriginRepo(repoPath: string): (OverviewRepoRef & { host: string }) | null {
  const commonDir = findGitCommonDir(repoPath)
  if (!commonDir) {
    return null
  }
  let text = ''
  try {
    text = readFileSync(join(commonDir, 'config'), 'utf8')
  } catch {
    return null
  }
  const url = parseGitConfigRemotePushUrls(text).find((remote) => remote.name === 'origin')
    ?.pushUrls[0]
  const parsed = url ? parseRemoteOwner(url) : null
  if (!url || !parsed || parsed.rewrittenToBlocked) {
    return null
  }
  const segments = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split(/[/:]/)
  const name = segments.at(-1) ?? ''
  if (segments.at(-2)?.toLowerCase() !== parsed.owner || !REPO_NAME_RE.test(name)) {
    return null
  }
  return { host: parsed.host.toLowerCase(), owner: parsed.owner, name }
}

/**
 * Cheap cache key for the repo list: the store's repos and the bindings, no fs reads. An origin
 * edited on disk shows up after the 5-minute expiry or a forced refresh.
 */
export function clientProfileOverviewRepoSignature(): string {
  const repos = listKnownClientProfileRepos().map((repo) => [
    repo.id,
    repo.path,
    repo.connectionId ?? null
  ])
  return JSON.stringify([repos, getClientProfileRepoBindings()])
}

export type ClientProfileOverviewRepos = {
  repos: OverviewRepoRef[]
  /** More repos matched than OVERVIEW_MAX_REPOS; the rest get no branch list. */
  truncated: boolean
}

/**
 * Local repos (not SSH) that resolve to `profile` and whose origin is in its allowedOrgs on its
 * host. A bound repo whose origin names another org is left out: the panel lists allowed orgs only.
 * Reads git config per repo, so it runs only on a cache miss.
 */
export function listClientProfileOverviewRepos(profile: ClientProfile): ClientProfileOverviewRepos {
  const refs = new Map<string, OverviewRepoRef>()
  for (const repo of listKnownClientProfileRepos()) {
    if (repo.connectionId || resolveRepoClientProfileId(repo) !== profile.id) {
      continue
    }
    const origin = readOriginRepo(repo.path)
    if (
      !origin ||
      origin.host !== profile.github.host ||
      !profile.github.allowedOrgs.includes(origin.owner)
    ) {
      continue
    }
    const key = `${origin.owner}/${origin.name.toLowerCase()}`
    if (refs.has(key)) {
      continue
    }
    if (refs.size >= OVERVIEW_MAX_REPOS) {
      return { repos: [...refs.values()], truncated: true }
    }
    refs.set(key, { owner: origin.owner, name: origin.name })
  }
  return { repos: [...refs.values()], truncated: false }
}
