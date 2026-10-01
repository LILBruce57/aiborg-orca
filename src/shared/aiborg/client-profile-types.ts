/**
 * AI-Borg client profiles: shared shapes for main, preload and renderer.
 * Profile JSON holds references only; secret values never appear in any type here.
 */

export const CLIENT_PROFILE_SCHEMA_VERSION = 1
export const CLIENT_PROFILE_SIDECAR_VERSION = 1

export type ClientProfileSecretRef = {
  /** Bitwarden item name or id, used by the optional `bw get password` import. */
  bitwarden?: string
}

export type ClientProfileMcpServer = {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type ClientProfile = {
  schemaVersion: 1
  id: string
  name: string
  color: string
  github: {
    host: string
    allowedOrgs: string[]
    login?: string
  }
  git: {
    userName: string
    userEmail: string
    /** Relative to the profile home; defaults to `ssh/id_ed25519.pub`. */
    sshPublicKey?: string
    includeGlobalGitconfig?: boolean
  }
  aws?: { profile?: string; region?: string }
  azure?: Record<string, never>
  gcloud?: { project?: string }
  secrets?: Record<string, ClientProfileSecretRef>
  env?: Record<string, string>
  mcp?: {
    claude?: Record<string, ClientProfileMcpServer>
    codex?: Record<string, ClientProfileMcpServer>
  }
  remote?: { allow: boolean; envAllowlist: string[] }
}

export type ClientProfileMachineSettings = {
  /** macOS: Bitwarden SSH agent socket. */
  sshAuthSock: string | null
  /** Windows: OpenSSH client that talks to the agent's named pipe. */
  windowsSsh: string | null
}

/** Main-owned machine state; never written through `settings:set`. */
export type ClientProfileSidecar = {
  version: 1
  profilesDir: string | null
  /** null = personal mode (stock behaviour, no profile env). */
  activeProfileId: string | null
  repoBindings: Record<string, string>
  ptyBindings: Record<string, string>
  storedSecretNames: Record<string, string[]>
  machine: ClientProfileMachineSettings
}

export type ClientProfileSecretState = 'set' | 'missing' | 'unknown'

export type ClientProfileLoginTool = 'claude' | 'codex' | 'gh' | 'az' | 'gcloud'

export type ClientProfileLoginStatus = Record<ClientProfileLoginTool, boolean>

export type ClientProfileListEntry = {
  id: string
  fileName: string
  /** null when the file failed validation. */
  profile: ClientProfile | null
  errors: string[]
  secretStatus: Record<string, ClientProfileSecretState>
  boundRepoIds: string[]
}

export type ClientProfilesState = {
  /** False until a profiles directory is configured. */
  enabled: boolean
  profilesDir: string | null
  /** `env` when AIBORG_PROFILES_DIR overrides the sidecar value. */
  profilesDirSource: 'env' | 'sidecar' | null
  profilesDirWritable: boolean
  profilesDirError: string | null
  profilesRoot: string
  activeProfileId: string | null
  keychainAvailable: boolean
  profiles: ClientProfileListEntry[]
  repoBindings: Record<string, string>
  ptyBindings: Record<string, string>
}

export type ClientProfileSpawnTarget =
  | { kind: 'local' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'wsl'; distro?: string | null }

export type ClientProfileAuditEvent =
  | 'profile.activate'
  | 'profile.deactivate'
  | 'profile.create'
  | 'profile.update'
  | 'profile.delete'
  | 'terminal.spawn'
  | 'terminal.refused'
  | 'structured.refused'
  | 'push.allowed'
  | 'push.blocked'
  | 'github.write.blocked'
  | 'github.overview.refresh'
  | 'repo.mismatch.shown'
  | 'repo.mismatch.override'
  | 'secret.set'
  | 'secret.delete'
  | 'keychain.error'

export type BitwardenImportResult =
  | { ok: true }
  | {
      ok: false
      reason: 'bw-missing' | 'bw-locked' | 'no-item-ref' | 'not-found' | 'failed'
      message: string
    }

export type ClientProfileSaveResult =
  | { ok: true; state: ClientProfilesState }
  | { ok: false; errors: string[] }

export type ClientProfileDeleteResult =
  | { ok: true; state: ClientProfilesState }
  | { ok: false; reason: 'confirm-mismatch' | 'in-use' | 'not-found' | 'failed'; message: string }

/** IPC channel names; see the contract at the top of src/main/aiborg/ipc/client-profile-ipc.ts. */
export const CLIENT_PROFILE_IPC = {
  getState: 'aiborgClientProfiles:getState',
  setProfilesDir: 'aiborgClientProfiles:setProfilesDir',
  activate: 'aiborgClientProfiles:activate',
  saveProfile: 'aiborgClientProfiles:saveProfile',
  deleteProfile: 'aiborgClientProfiles:deleteProfile',
  setSecret: 'aiborgClientProfiles:setSecret',
  deleteSecret: 'aiborgClientProfiles:deleteSecret',
  importSecretFromBitwarden: 'aiborgClientProfiles:importSecretFromBitwarden',
  getBitwardenStatus: 'aiborgClientProfiles:getBitwardenStatus',
  bindRepo: 'aiborgClientProfiles:bindRepo',
  resolveRepoProfile: 'aiborgClientProfiles:resolveRepoProfile',
  getLoginStatus: 'aiborgClientProfiles:getLoginStatus',
  writeSshPublicKey: 'aiborgClientProfiles:writeSshPublicKey',
  readSshPublicKey: 'aiborgClientProfiles:readSshPublicKey',
  removeSshPrivateKey: 'aiborgClientProfiles:removeSshPrivateKey',
  recordMismatch: 'aiborgClientProfiles:recordMismatch',
  setMachineSettings: 'aiborgClientProfiles:setMachineSettings',
  getOverview: 'aiborgClientProfiles:getOverview',
  changed: 'aiborgClientProfiles:changed'
} as const

export type BitwardenStatus = 'unavailable' | 'unauthenticated' | 'locked' | 'unlocked'
