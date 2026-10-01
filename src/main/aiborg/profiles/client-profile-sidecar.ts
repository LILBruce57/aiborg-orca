import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../../codex-accounts/fs-utils'
import {
  CLIENT_PROFILE_SIDECAR_VERSION,
  type ClientProfileMachineSettings,
  type ClientProfileSidecar
} from '../../../shared/aiborg/client-profile-types'
import { CLIENT_PROFILE_ID_RE } from '../../../shared/aiborg/client-profile-schema'
import type { ClientProfileSecretNameRegistry } from '../keychain/client-profile-keychain'

export const CLIENT_PROFILE_SIDECAR_FILE = 'aiborg-client-profiles.json'

export function clientProfileSidecarPath(userDataPath: string): string {
  return join(userDataPath, CLIENT_PROFILE_SIDECAR_FILE)
}

export function defaultClientProfileSidecar(): ClientProfileSidecar {
  return {
    version: CLIENT_PROFILE_SIDECAR_VERSION,
    profilesDir: null,
    activeProfileId: null,
    repoBindings: {},
    ptyBindings: {},
    storedSecretNames: {},
    machine: { sshAuthSock: null, windowsSsh: null }
  }
}

function stringRecord(value: unknown, validValue: (v: string) => boolean): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && validValue(entry[1])
    )
  )
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

const isProfileId = (value: string): boolean => CLIENT_PROFILE_ID_RE.test(value)

export function normalizeClientProfileSidecar(raw: unknown): ClientProfileSidecar {
  const base = defaultClientProfileSidecar()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base
  }
  const record: Record<string, unknown> = { ...raw }
  const names = record.storedSecretNames
  const machine: Record<string, unknown> =
    record.machine && typeof record.machine === 'object' ? { ...record.machine } : {}
  const activeProfileId = nullableString(record.activeProfileId)
  return {
    ...base,
    profilesDir: nullableString(record.profilesDir),
    activeProfileId: activeProfileId && isProfileId(activeProfileId) ? activeProfileId : null,
    repoBindings: stringRecord(record.repoBindings, isProfileId),
    ptyBindings: stringRecord(record.ptyBindings, isProfileId),
    storedSecretNames:
      names && typeof names === 'object' && !Array.isArray(names)
        ? Object.fromEntries(
            Object.entries(names)
              .filter(([id, list]) => isProfileId(id) && Array.isArray(list))
              .map(([id, list]: [string, unknown[]]) => [
                id,
                list.filter((name): name is string => typeof name === 'string')
              ])
          )
        : {},
    machine: {
      sshAuthSock: nullableString(machine.sshAuthSock),
      windowsSsh: nullableString(machine.windowsSsh)
    }
  }
}

// Why debounced: every terminal open and close changes ptyBindings; a synchronous atomic write
// per change on main adds up and fails spawns when antivirus or OneDrive holds the file.
const PTY_BINDING_PERSIST_DELAY_MS = 250
const storesWithPendingWrites = new Set<ClientProfileSidecarStore>()
let exitFlushInstalled = false

function installExitFlush(): void {
  if (exitFlushInstalled) {
    return
  }
  exitFlushInstalled = true
  process.once('exit', () => {
    for (const store of storesWithPendingWrites) {
      store.flush()
    }
  })
}

/** Main-owned state file; changed only through dedicated IPC, never `settings:set`. */
export class ClientProfileSidecarStore implements ClientProfileSecretNameRegistry {
  private cached: ClientProfileSidecar | null = null
  private readonly listeners = new Set<(state: ClientProfileSidecar) => void>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(readonly filePath: string) {}

  read(): ClientProfileSidecar {
    if (this.cached) {
      return this.cached
    }
    let text: string | null = null
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      this.cached = defaultClientProfileSidecar()
      return this.cached
    }
    try {
      this.cached = normalizeClientProfileSidecar(JSON.parse(text))
    } catch {
      // Why keep a copy: the secret-name list is the only way to clean up keychain entries later.
      copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
      this.cached = defaultClientProfileSidecar()
    }
    return this.cached
  }

  private write(state: ClientProfileSidecar): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileAtomically(this.filePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  private emit(state: ClientProfileSidecar): void {
    for (const listener of this.listeners) {
      listener(state)
    }
  }

  private cancelPendingWrite(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    storesWithPendingWrites.delete(this)
  }

  update(mutate: (draft: ClientProfileSidecar) => void): ClientProfileSidecar {
    const draft = structuredClone(this.read())
    mutate(draft)
    const next = normalizeClientProfileSidecar(draft)
    this.write(next)
    // The write carried any pending ptyBindings change too.
    this.cancelPendingWrite()
    this.cached = next
    this.emit(next)
    return next
  }

  /** Writes a pending ptyBindings change now; best effort (the in-memory state stays right). */
  flush(): void {
    if (!this.persistTimer && !storesWithPendingWrites.has(this)) {
      return
    }
    this.cancelPendingWrite()
    try {
      this.write(this.read())
    } catch (error) {
      console.warn('[aiborg] could not persist terminal profile bindings', error)
    }
  }

  onChange(listener: (state: ClientProfileSidecar) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setProfilesDir(dir: string | null): ClientProfileSidecar {
    return this.update((draft) => {
      draft.profilesDir = dir
    })
  }

  setActiveProfileId(profileId: string | null): ClientProfileSidecar {
    return this.update((draft) => {
      draft.activeProfileId = profileId
    })
  }

  setRepoBinding(repoId: string, profileId: string | null): ClientProfileSidecar {
    return this.update((draft) => {
      if (profileId) {
        draft.repoBindings[repoId] = profileId
      } else {
        delete draft.repoBindings[repoId]
      }
    })
  }

  /** In memory at once, on disk debounced: never throws for a write failure. */
  setPtyBinding(ptyId: string, profileId: string | null): ClientProfileSidecar {
    const current = this.read()
    if ((current.ptyBindings[ptyId] ?? null) === profileId) {
      return current
    }
    const ptyBindings = { ...current.ptyBindings }
    if (profileId) {
      ptyBindings[ptyId] = profileId
    } else {
      delete ptyBindings[ptyId]
    }
    const next = normalizeClientProfileSidecar({ ...current, ptyBindings })
    this.cached = next
    if (!this.persistTimer) {
      installExitFlush()
      storesWithPendingWrites.add(this)
      this.persistTimer = setTimeout(() => this.flush(), PTY_BINDING_PERSIST_DELAY_MS)
      this.persistTimer.unref?.()
    }
    this.emit(next)
    return next
  }

  setMachine(machine: Partial<ClientProfileMachineSettings>): ClientProfileSidecar {
    return this.update((draft) => {
      draft.machine = { ...draft.machine, ...machine }
    })
  }

  listSecretNames(profileId: string): string[] {
    return [...(this.read().storedSecretNames[profileId] ?? [])]
  }

  recordSecretName(profileId: string, name: string): void {
    if (this.listSecretNames(profileId).includes(name)) {
      return
    }
    this.update((draft) => {
      draft.storedSecretNames[profileId] = [...(draft.storedSecretNames[profileId] ?? []), name]
    })
  }

  forgetSecretName(profileId: string, name: string): void {
    this.update((draft) => {
      const remaining = (draft.storedSecretNames[profileId] ?? []).filter((item) => item !== name)
      if (remaining.length > 0) {
        draft.storedSecretNames[profileId] = remaining
      } else {
        delete draft.storedSecretNames[profileId]
      }
    })
  }

  /** Delete flow step 6: bindings and secret names of one profile. */
  removeProfile(profileId: string): ClientProfileSidecar {
    return this.update((draft) => {
      const keep = (bindings: Record<string, string>): Record<string, string> =>
        Object.fromEntries(Object.entries(bindings).filter(([, id]) => id !== profileId))
      draft.repoBindings = keep(draft.repoBindings)
      draft.ptyBindings = keep(draft.ptyBindings)
      delete draft.storedSecretNames[profileId]
      if (draft.activeProfileId === profileId) {
        draft.activeProfileId = null
      }
    })
  }
}
