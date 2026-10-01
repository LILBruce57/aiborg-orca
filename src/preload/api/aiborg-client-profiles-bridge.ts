import { ipcRenderer } from 'electron'
import {
  CLIENT_PROFILE_IPC,
  type ClientProfilesState
} from '../../shared/aiborg/client-profile-types'
import type { AiborgClientProfilesApi, AiborgPreloadApi } from './aiborg-client-profiles-api'

export const aiborgClientProfilesApi = {
  getState: () => ipcRenderer.invoke(CLIENT_PROFILE_IPC.getState),
  setProfilesDir: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.setProfilesDir, args),
  activate: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.activate, args),
  saveProfile: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.saveProfile, args),
  deleteProfile: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.deleteProfile, args),
  setSecret: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.setSecret, args),
  deleteSecret: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.deleteSecret, args),
  importSecretFromBitwarden: (args) =>
    ipcRenderer.invoke(CLIENT_PROFILE_IPC.importSecretFromBitwarden, args),
  getBitwardenStatus: () => ipcRenderer.invoke(CLIENT_PROFILE_IPC.getBitwardenStatus),
  bindRepo: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.bindRepo, args),
  resolveRepoProfile: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.resolveRepoProfile, args),
  getLoginStatus: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.getLoginStatus, args),
  writeSshPublicKey: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.writeSshPublicKey, args),
  readSshPublicKey: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.readSshPublicKey, args),
  removeSshPrivateKey: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.removeSshPrivateKey, args),
  recordMismatch: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.recordMismatch, args),
  setMachineSettings: (args) => ipcRenderer.invoke(CLIENT_PROFILE_IPC.setMachineSettings, args),
  onChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: ClientProfilesState): void =>
      callback(state)
    ipcRenderer.on(CLIENT_PROFILE_IPC.changed, listener)
    return () => {
      ipcRenderer.removeListener(CLIENT_PROFILE_IPC.changed, listener)
    }
  }
} satisfies AiborgClientProfilesApi

/** H38 exposes this as `window.aiborg`. */
export const aiborgApi = {
  clientProfiles: aiborgClientProfilesApi
} satisfies AiborgPreloadApi
