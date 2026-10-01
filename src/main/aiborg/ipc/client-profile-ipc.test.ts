import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CLIENT_PROFILE_IPC } from '../../../shared/aiborg/client-profile-types'

const { handlers, sent } = vi.hoisted(() => {
  const sentStates: unknown[] = []
  return {
    handlers: new Map<string, (event: unknown, args?: unknown) => unknown>(),
    sent: sentStates
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: (_c: string, state: unknown) => sent.push(state) }
      }
    ]
  }
}))

vi.mock('../../git/runner', () => ({
  gitExecFileAsync: vi.fn(async () => ({ stdout: 'git version 2.45.0\n', stderr: '' }))
}))

import {
  initClientProfilesForMain,
  registerAiborgClientProfileHandlers,
  resetClientProfilesForTests
} from './client-profile-ipc'
import { getClientProfileRuntime } from '../profiles/client-profile-runtime'

let dir = ''
const keyring = new Map<string, string>()
let keyringReads = 0
// Why async: ipcMain turns a handler's synchronous throw into a rejected invoke.
const invoke = async (channel: string, args?: unknown): Promise<unknown> =>
  handlers.get(channel)?.({}, args)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiborg-ipc-'))
  mkdirSync(join(dir, 'clients'))
  initClientProfilesForMain({
    userDataPath: join(dir, 'userData'),
    env: { AIBORG_PROFILES_ROOT: join(dir, 'profiles') },
    home: join(dir, 'home'),
    loadKeyringBackend: () => ({
      createEntry: (service, account) => ({
        getPassword: () => {
          keyringReads += 1
          return keyring.get(`${service}|${account}`) ?? null
        },
        setPassword: (value) => {
          keyring.set(`${service}|${account}`, value)
        },
        deletePassword: () => keyring.delete(`${service}|${account}`)
      })
    })
  })
  registerAiborgClientProfileHandlers()
})

afterAll(() => {
  resetClientProfilesForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('client profile IPC contract', () => {
  it('registers every channel in CLIENT_PROFILE_IPC except the event', () => {
    const invokable = Object.values(CLIENT_PROFILE_IPC).filter(
      (c) => c !== CLIENT_PROFILE_IPC.changed
    )
    expect([...handlers.keys()].sort()).toEqual([...invokable].sort())
  })

  it('walks the wizard flow without a secret ever coming back', async () => {
    await invoke(CLIENT_PROFILE_IPC.setProfilesDir, { dir: join(dir, 'clients') })
    const saved = await invoke(CLIENT_PROFILE_IPC.saveProfile, {
      profile: {
        schemaVersion: 1,
        id: 'acme',
        name: 'Acme',
        color: '#2F80ED',
        github: { allowedOrgs: ['acme-inc'] },
        git: { userName: 'Example Name', userEmail: 'dev@acme.example' },
        secrets: { GH_TOKEN: { bitwarden: 'acme / GitHub' } }
      }
    })
    expect(saved).toMatchObject({ ok: true })
    const status = await invoke(CLIENT_PROFILE_IPC.setSecret, {
      profileId: 'acme',
      name: 'GH_TOKEN',
      value: 'fixture-secret-value'
    })
    expect(status).toEqual({ GH_TOKEN: 'set' })
    await expect(
      invoke(CLIENT_PROFILE_IPC.setSecret, { profileId: 'acme', name: 'OTHER', value: 'x' })
    ).rejects.toThrow(/not a secret of profile/)
    await invoke(CLIENT_PROFILE_IPC.writeSshPublicKey, {
      profileId: 'acme',
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample dev@acme.example'
    })
    expect(await invoke(CLIENT_PROFILE_IPC.readSshPublicKey, { profileId: 'acme' })).toMatch(
      /^ssh-ed25519 /
    )
    await expect(
      invoke(CLIENT_PROFILE_IPC.writeSshPublicKey, {
        profileId: 'acme',
        publicKey: '-----BEGIN OPENSSH PRIVATE KEY-----'
      })
    ).rejects.toThrow(/not a single-line OpenSSH public key/)
    const state = await invoke(CLIENT_PROFILE_IPC.activate, { profileId: 'acme' })
    expect(state).toMatchObject({ activeProfileId: 'acme', profilesDirSource: 'sidecar' })
    await invoke(CLIENT_PROFILE_IPC.bindRepo, { repoId: 'repo-1', profileId: 'acme' })
    const login = await invoke(CLIENT_PROFILE_IPC.getLoginStatus, { profileId: 'acme' })
    expect(login).toEqual({ claude: false, codex: false, gh: false, az: false, gcloud: false })
    expect(sent.length).toBeGreaterThan(0)
    expect(JSON.stringify([state, ...sent])).not.toContain('fixture-secret-value')
  })

  it('terminal open/close broadcasts read no keychain entries and coalesce', async () => {
    await invoke(CLIENT_PROFILE_IPC.getState)
    const readsBefore = keyringReads
    const sentBefore = sent.length
    const sidecar = getClientProfileRuntime()?.sidecar
    for (let i = 0; i < 10; i++) {
      sidecar?.setPtyBinding(`pty-${i}`, 'acme')
      sidecar?.setPtyBinding(`pty-${i}`, null)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(keyringReads).toBe(readsBefore)
    expect(sent.length - sentBefore).toBe(1)
    // A secret change refreshes the cached status.
    await invoke(CLIENT_PROFILE_IPC.deleteSecret, { profileId: 'acme', name: 'GH_TOKEN' })
    const state = await invoke(CLIENT_PROFILE_IPC.getState)
    expect(JSON.stringify(state)).toContain('"GH_TOKEN":"missing"')
  })

  it('rejects malformed arguments', async () => {
    await expect(invoke(CLIENT_PROFILE_IPC.activate, { profileId: '../x' })).rejects.toThrow(
      /invalid profile id/
    )
    await expect(invoke(CLIENT_PROFILE_IPC.getLoginStatus, {})).rejects.toThrow(/missing profileId/)
  })
})
