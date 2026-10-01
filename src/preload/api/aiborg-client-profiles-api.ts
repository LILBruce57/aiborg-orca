import type {
  BitwardenImportResult,
  BitwardenStatus,
  ClientProfileDeleteResult,
  ClientProfileLoginStatus,
  ClientProfileSaveResult,
  ClientProfileSecretState,
  ClientProfilesState
} from '../../shared/aiborg/client-profile-types'

/** Renderer contract for client profiles; documented in src/main/aiborg/ipc/client-profile-ipc.ts. */
export type AiborgClientProfilesApi = {
  getState: () => Promise<ClientProfilesState>
  setProfilesDir: (args: { dir: string | null }) => Promise<ClientProfilesState>
  /** null switches to personal mode. */
  activate: (args: { profileId: string | null }) => Promise<ClientProfilesState>
  /** `profile` is the unvalidated draft; main validates it with the shared schema. */
  saveProfile: (args: {
    profile: unknown
    previousId?: string | null
  }) => Promise<ClientProfileSaveResult>
  deleteProfile: (args: {
    profileId: string
    confirmId: string
    deleteJson: boolean
  }) => Promise<ClientProfileDeleteResult>
  setSecret: (args: {
    profileId: string
    name: string
    value: string
  }) => Promise<Record<string, ClientProfileSecretState>>
  deleteSecret: (args: {
    profileId: string
    name: string
  }) => Promise<Record<string, ClientProfileSecretState>>
  importSecretFromBitwarden: (args: {
    profileId: string
    name: string
    /** Defaults to the profile's `secrets.<name>.bitwarden` reference. */
    item?: string | null
  }) => Promise<BitwardenImportResult>
  getBitwardenStatus: () => Promise<BitwardenStatus>
  bindRepo: (args: { repoId: string; profileId: string | null }) => Promise<ClientProfilesState>
  /** The profile a repo belongs to: its binding, else its remotes' org, origin first (§1.2). */
  resolveRepoProfile: (args: { repoId: string }) => Promise<{ profileId: string | null }>
  getLoginStatus: (args: { profileId: string }) => Promise<ClientProfileLoginStatus>
  writeSshPublicKey: (args: { profileId: string; publicKey: string }) => Promise<void>
  readSshPublicKey: (args: { profileId: string }) => Promise<string | null>
  removeSshPrivateKey: (args: { profileId: string }) => Promise<void>
  recordMismatch: (args: {
    profileId: string
    event: 'repo.mismatch.shown' | 'repo.mismatch.override'
    worktreeId?: string | null
  }) => Promise<void>
  setMachineSettings: (args: {
    sshAuthSock?: string | null
    windowsSsh?: string | null
  }) => Promise<ClientProfilesState>
  onChanged: (callback: (state: ClientProfilesState) => void) => () => void
}

export type AiborgPreloadApi = {
  clientProfiles: AiborgClientProfilesApi
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    /** Exposed by H38 (`contextBridge.exposeInMainWorld('aiborg', aiborgApi)`). */
    aiborg: AiborgPreloadApi
  }
}
