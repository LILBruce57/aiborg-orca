import {
  accessSync,
  constants,
  readdirSync,
  readFileSync,
  rmSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { join, resolve } from 'node:path'
import { writeFileAtomically } from '../../codex-accounts/fs-utils'
import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import {
  CLIENT_PROFILE_ID_RE,
  findDuplicateAllowedOrgs,
  validateClientProfile
} from '../../../shared/aiborg/client-profile-schema'
import { AIBORG_PROFILES_DIR_ENV } from './client-profile-paths'

/** The host and orgs a profile file names, read even when the file fails validation. */
export type ClientProfileOrgClaim = { host: string; orgs: string[] }

export type ClientProfileFileEntry = {
  id: string
  fileName: string
  profile: ClientProfile | null
  errors: string[]
  claim: ClientProfileOrgClaim | null
}

export type ClientProfilesSnapshot = {
  dir: string | null
  source: 'env' | 'sidecar' | null
  writable: boolean
  error: string | null
  entries: ClientProfileFileEntry[]
}

const EMPTY: ClientProfilesSnapshot = {
  dir: null,
  source: null,
  writable: false,
  error: null,
  entries: []
}

export function resolveClientProfilesDir(
  sidecarDir: string | null,
  env: NodeJS.ProcessEnv = process.env
): { dir: string | null; source: 'env' | 'sidecar' | null } {
  const override = env[AIBORG_PROFILES_DIR_ENV]?.trim()
  if (override) {
    return { dir: resolve(override), source: 'env' }
  }
  return sidecarDir ? { dir: resolve(sidecarDir), source: 'sidecar' } : { dir: null, source: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Best effort over unvalidated JSON, so a broken file still claims its orgs (fail closed). */
export function readClientProfileOrgClaim(raw: unknown): ClientProfileOrgClaim | null {
  const github = isRecord(raw) && isRecord(raw.github) ? raw.github : null
  const orgs = Array.isArray(github?.allowedOrgs)
    ? github.allowedOrgs
        .filter((org): org is string => typeof org === 'string' && org.trim() !== '')
        .map((org) => org.trim().toLowerCase())
    : []
  if (orgs.length === 0) {
    return null
  }
  const host = typeof github?.host === 'string' && github.host.trim() ? github.host : 'github.com'
  return { host: host.trim().toLowerCase(), orgs }
}

function readEntry(
  dir: string,
  fileName: string,
  previousClaim: ClientProfileOrgClaim | null
): ClientProfileFileEntry {
  const id = fileName.slice(0, -'.json'.length)
  if (!CLIENT_PROFILE_ID_RE.test(id)) {
    return {
      id,
      fileName,
      profile: null,
      errors: ['file name is not a valid profile id'],
      claim: null
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, fileName), 'utf8'))
  } catch (error) {
    // Why the previous claim: a half-written or conflicted file must not free its repos.
    return {
      id,
      fileName,
      profile: null,
      errors: [`unreadable JSON: ${error instanceof Error ? error.message : String(error)}`],
      claim: previousClaim
    }
  }
  const claim = readClientProfileOrgClaim(raw) ?? previousClaim
  const result = validateClientProfile(raw, id)
  return result.ok
    ? { id, fileName, profile: result.profile, errors: [], claim }
    : { id, fileName, profile: null, errors: result.errors, claim }
}

/** Reads and validates `<dir>/*.json`; an org claimed by two profiles invalidates both. */
export function loadClientProfilesDir(
  dir: string,
  previousClaims: ReadonlyMap<string, ClientProfileOrgClaim> = new Map()
): Omit<ClientProfilesSnapshot, 'source'> {
  let fileNames: string[]
  try {
    fileNames = readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.json'))
      .sort()
  } catch (error) {
    return { ...EMPTY, dir, error: error instanceof Error ? error.message : String(error) }
  }
  const entries = fileNames.map((name) =>
    readEntry(dir, name, previousClaims.get(name.slice(0, -'.json'.length)) ?? null)
  )
  const duplicates = findDuplicateAllowedOrgs(
    entries.flatMap((entry) => (entry.profile ? [entry.profile] : []))
  )
  for (const [org, ids] of duplicates) {
    for (const entry of entries.filter((item) => ids.includes(item.id))) {
      entry.errors.push(
        `org ${org} is also listed in: ${ids.filter((id) => id !== entry.id).join(', ')}`
      )
      entry.profile = null
    }
  }
  let writable = true
  try {
    accessSync(dir, constants.W_OK)
  } catch {
    writable = false
  }
  return { dir, writable, error: null, entries }
}

/** Profile definitions from the private profiles directory, cached and watched. */
export class ClientProfileStore {
  private snapshotState: ClientProfilesSnapshot = EMPTY
  private watcher: FSWatcher | null = null
  private watchedDir: string | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly getSidecarDir: () => string | null,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  reload(): ClientProfilesSnapshot {
    const { dir, source } = resolveClientProfilesDir(this.getSidecarDir(), this.env)
    const previousClaims = new Map<string, ClientProfileOrgClaim>()
    if (dir && dir === this.snapshotState.dir) {
      for (const entry of this.snapshotState.entries) {
        if (entry.claim) {
          previousClaims.set(entry.id, entry.claim)
        }
      }
    }
    this.snapshotState = dir ? { ...loadClientProfilesDir(dir, previousClaims), source } : EMPTY
    return this.snapshotState
  }

  snapshot(): ClientProfilesSnapshot {
    return this.snapshotState
  }

  getProfile(profileId: string): ClientProfile | null {
    return this.snapshotState.entries.find((entry) => entry.id === profileId)?.profile ?? null
  }

  /** Ids of every profile file (valid or not) whose orgs include `owner` on `host`. */
  claimingProfileIds(host: string, owner: string): string[] {
    const normalizedHost = host.toLowerCase()
    const normalizedOwner = owner.toLowerCase()
    return this.snapshotState.entries
      .filter(
        (entry) =>
          entry.claim?.host === normalizedHost && entry.claim.orgs.includes(normalizedOwner)
      )
      .map((entry) => entry.id)
  }

  validProfiles(): ClientProfile[] {
    return this.snapshotState.entries.flatMap((entry) => (entry.profile ? [entry.profile] : []))
  }

  /** Union of `env` and `secrets` keys across loaded profiles (managed set, design §3.2). */
  managedKeyUnion(): string[] {
    const keys = new Set<string>()
    for (const profile of this.validProfiles()) {
      Object.keys(profile.env ?? {}).forEach((key) => keys.add(key))
      Object.keys(profile.secrets ?? {}).forEach((key) => keys.add(key))
    }
    return [...keys]
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  /** (Re)starts the directory watcher for the current profiles dir. */
  watch(): void {
    const dir = this.snapshotState.dir
    if (dir === this.watchedDir) {
      return
    }
    this.stopWatching()
    if (!dir || this.snapshotState.error) {
      return
    }
    try {
      this.watcher = watch(dir, () => {
        if (this.debounce) {
          clearTimeout(this.debounce)
        }
        this.debounce = setTimeout(() => {
          this.reload()
          this.emit()
        }, 200)
      })
      this.watchedDir = dir
    } catch {
      this.watcher = null
    }
  }

  stopWatching(): void {
    this.watcher?.close()
    this.watcher = null
    this.watchedDir = null
    if (this.debounce) {
      clearTimeout(this.debounce)
      this.debounce = null
    }
  }

  private requireWritableDir(): string {
    const { dir, writable } = this.snapshotState
    if (!dir || !writable) {
      throw new Error('AI-Borg: the profiles directory is not set or not writable')
    }
    return dir
  }

  writeProfile(profile: ClientProfile): void {
    const dir = this.requireWritableDir()
    writeFileAtomically(join(dir, `${profile.id}.json`), `${JSON.stringify(profile, null, 2)}\n`)
    this.reload()
  }

  deleteProfileFile(profileId: string): void {
    if (!CLIENT_PROFILE_ID_RE.test(profileId)) {
      throw new Error('AI-Borg: invalid client profile id')
    }
    rmSync(join(this.requireWritableDir(), `${profileId}.json`), { force: true })
    this.reload()
  }
}
