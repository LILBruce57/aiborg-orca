import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../../../shared/child-process/run-process'
import type { ProcessResult } from '../../../shared/child-process/process-spec'
import { resolveCommand } from '../../git/command-runner/wsl-command-resolution'
import { UNTRANSLATED_GIT_OUTPUT_ENV } from '../../../shared/git-output-locale'
import { parseRemoteOwner } from '../git/client-profile-remote-owner'
import {
  findGitCommonDir,
  gitConfigHasIncludes,
  parseGitConfigRemotePushUrls,
  type GitRemotePushUrls
} from './client-profile-git-dir'

export type HostedRemoteOwner = { host: string; owner: string }

/** `origin`'s push-URL owners, and those of every other remote. */
export type RepoRemoteOwners = { origin: HostedRemoteOwner[]; others: HostedRemoteOwner[] }

type CacheEntry = {
  owners: RepoRemoteOwners
  configPath: string | null
  configMtimeMs: number | null
  checkedAt: number
}

// Why a re-check interval: a stat per git call is cheap locally but not over a WSL 9P share.
const RECHECK_MS = 2_000
const PROBE_TIMEOUT_MS = 5_000
const cache = new Map<string, CacheEntry>()
const probesInFlight = new Map<string, Promise<void>>()

function mtimeOf(path: string | null): number | null {
  if (!path) {
    return null
  }
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** `gh:acme/app` style insteadOf aliases; local paths and file URLs never have an owner. */
function isPossiblyAliasedUrl(url: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]+:/.test(url) && !/^file:/i.test(url)
}

function ownersFromUrls(urls: readonly string[]): {
  owners: HostedRemoteOwner[]
  unparsed: boolean
} {
  const owners = new Map<string, HostedRemoteOwner>()
  let unparsed = false
  for (const url of urls) {
    const parsed = parseRemoteOwner(url)
    if (parsed && !parsed.rewrittenToBlocked) {
      owners.set(`${parsed.host}/${parsed.owner}`, { host: parsed.host, owner: parsed.owner })
    } else if (!parsed && isPossiblyAliasedUrl(url)) {
      unparsed = true
    }
  }
  return { owners: [...owners.values()], unparsed }
}

function ownersFromRemotes(remotes: readonly GitRemotePushUrls[]): {
  owners: RepoRemoteOwners
  unparsed: boolean
} {
  const origin = ownersFromUrls(remotes.find((r) => r.name === 'origin')?.pushUrls ?? [])
  const others = ownersFromUrls(
    remotes.filter((r) => r.name !== 'origin').flatMap((r) => r.pushUrls)
  )
  return {
    owners: { origin: origin.owners, others: others.owners },
    unparsed: origin.unparsed || others.unparsed
  }
}

function readFromConfig(repoPath: string): { entry: CacheEntry; needsProbe: boolean } {
  const commonDir = findGitCommonDir(repoPath)
  const configPath = commonDir ? join(commonDir, 'config') : null
  let text = ''
  try {
    text = configPath ? readFileSync(configPath, 'utf8') : ''
  } catch {
    text = ''
  }
  const { owners, unparsed } = ownersFromRemotes(parseGitConfigRemotePushUrls(text))
  return {
    entry: { owners, configPath, configMtimeMs: mtimeOf(configPath), checkedAt: Date.now() },
    needsProbe: unparsed || gitConfigHasIncludes(text)
  }
}

function probeSpec(repoPath: string) {
  // Why not gitExecFile: that runner injects profile env, which this lookup decides.
  const resolved = resolveCommand('git', ['remote', '-v'], repoPath)
  return {
    program: resolved.binary,
    args: resolved.args,
    cwd: resolved.cwd,
    env: { ...process.env, ...UNTRANSLATED_GIT_OUTPUT_ENV },
    timeoutMs: PROBE_TIMEOUT_MS
  }
}

function pushUrlsFromRemoteList(result: ProcessResult): GitRemotePushUrls[] | null {
  if (result.code !== 0) {
    return null
  }
  const remotes = new Map<string, string[]>()
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(push\)\s*$/)
    if (match) {
      remotes.set(match[1], [...(remotes.get(match[1]) ?? []), match[2]])
    }
  }
  return [...remotes.entries()].map(([name, pushUrls]) => ({ name, pushUrls }))
}

function mergeOwners(
  primary: readonly HostedRemoteOwner[],
  extra: readonly HostedRemoteOwner[]
): HostedRemoteOwner[] {
  const merged = [...primary]
  for (const owner of extra) {
    if (!merged.some((item) => item.host === owner.host && item.owner === owner.owner)) {
      merged.push(owner)
    }
  }
  return merged
}

/** Refines an fs read with git's own view (insteadOf aliases, includes); never blocks main. */
function refineWithGit(repoPath: string, entry: CacheEntry): void {
  if (probesInFlight.has(repoPath)) {
    return
  }
  const probe = runProcess(probeSpec(repoPath))
    .then((result) => {
      const remotes = pushUrlsFromRemoteList(result)
      // Why keep the fs answer on failure: a failed probe is not evidence of "no owner".
      if (remotes && cache.get(repoPath) === entry) {
        const probed = ownersFromRemotes(remotes).owners
        cache.set(repoPath, {
          ...entry,
          owners: {
            origin: mergeOwners(probed.origin, entry.owners.origin),
            others: mergeOwners(probed.others, entry.owners.others)
          }
        })
      }
    })
    .catch(() => undefined)
    .finally(() => probesInFlight.delete(repoPath))
  probesInFlight.set(repoPath, probe)
}

function freshEntry(repoPath: string): CacheEntry {
  const cached = cache.get(repoPath)
  const now = Date.now()
  if (cached && now - cached.checkedAt < RECHECK_MS) {
    return cached
  }
  if (cached?.configPath && mtimeOf(cached.configPath) === cached.configMtimeMs) {
    cached.checkedAt = now
    return cached
  }
  const { entry, needsProbe } = readFromConfig(repoPath)
  cache.set(repoPath, entry)
  if (needsProbe) {
    refineWithGit(repoPath, entry)
  }
  return entry
}

/**
 * Push-URL owners of `origin` and of every other remote (design §1.2), read from the repo's
 * git config without spawning git, and re-read when that file changes.
 */
export function readRepoRemoteOwners(repoPath: string): RepoRemoteOwners {
  return freshEntry(repoPath).owners
}

export function forgetRemoteOwnerCache(repoPath?: string): void {
  if (repoPath === undefined) {
    cache.clear()
  } else {
    cache.delete(repoPath)
  }
}
