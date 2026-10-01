import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnvironment } from '../../shared/app-environment'

const UPSTREAM_FLAG = 'AIBORG_UPSTREAM_BEHAVIOR_IN_TESTS'
const originalPlatform = process.platform
const originalLocalAppData = process.env.LOCALAPPDATA
let savedFlag: string | undefined

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true, writable: true })
}

beforeEach(() => {
  // Why resetModules: H2/H5 resolve brand constants at module load, after the flag is cleared.
  savedFlag = process.env[UPSTREAM_FLAG]
  delete process.env[UPSTREAM_FLAG]
  vi.resetModules()
})

afterEach(() => {
  if (savedFlag === undefined) {
    delete process.env[UPSTREAM_FLAG]
  } else {
    process.env[UPSTREAM_FLAG] = savedFlag
  }
  setPlatform(originalPlatform)
  if (originalLocalAppData === undefined) {
    delete process.env.LOCALAPPDATA
  } else {
    process.env.LOCALAPPDATA = originalLocalAppData
  }
})

describe('AI-Borg identity (H2)', () => {
  it('names the packaged and dev app AI-Borg with its own AppUserModelID', async () => {
    const { getDevInstanceIdentity } = await import('../startup/dev-instance-identity')
    expect(getDevInstanceIdentity(false, {})).toMatchObject({
      name: 'AI-Borg',
      appName: 'AI-Borg',
      appUserModelId: 'be.aiborg.desktop'
    })
    const dev = getDevInstanceIdentity(true, {
      devWorktreeName: 'dev-indicator',
      devRepoRoot: '/repo/worktrees/dev-indicator'
    })
    expect(dev.appName).toBe('AI-Borg Dev')
    // H2b: the dev bundle name keys the macOS safeStorage Keychain item, so it must match.
    const { DEV_BUNDLE_DISPLAY_NAME } =
      await import('../../../config/scripts/dev-electron-bundle-identity.mjs')
    expect(DEV_BUNDLE_DISPLAY_NAME).toBe(dev.appName)
    expect(dev.appUserModelId).toMatch(/^be\.aiborg\.desktop\.dev\.[a-f0-9]{10}$/)
  })
})

describe('AI-Borg daemon host root (H5)', () => {
  let localAppData: string

  beforeEach(() => {
    localAppData = mkdtempSync(join(tmpdir(), 'aiborg-daemon-host-'))
    process.env.LOCALAPPDATA = localAppData
    setPlatform('win32')
  })

  afterEach(() => {
    rmSync(localAppData, { recursive: true, force: true })
  })

  it('prunes only its own daemon-host folder, never stock Orca’s', async () => {
    const { setAppEnvironment } = await import('../../shared/app-environment')
    const { pruneOldDaemonHosts } = await import('../daemon/daemon-host-relocation')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pruning reads only isPackaged, getAppPath and getVersion.
    setAppEnvironment({
      isPackaged: () => true,
      getAppPath: () => join(localAppData, 'install', 'resources', 'app.asar'),
      getVersion: () => '9.9.9'
    } as AppEnvironment)
    const aiborgOld = join(localAppData, 'AI-Borg', 'daemon-host', '1.0.0')
    const stockOrcaOld = join(localAppData, 'Orca', 'daemon-host', '1.0.0')
    mkdirSync(aiborgOld, { recursive: true })
    mkdirSync(stockOrcaOld, { recursive: true })

    pruneOldDaemonHosts({ status: 'complete', versionLiveness: new Map() })

    expect(existsSync(aiborgOld)).toBe(false)
    expect(existsSync(stockOrcaOld)).toBe(true)
  })
})

describe('AI-Borg orcad browser host (H57)', () => {
  it('only launches AI-Borg’s own install', async () => {
    const { installedElectronCandidates } = await import('../orcad/orcad-browser-provider')
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }
    expect(installedElectronCandidates('win32', 'C:\\Users\\u', env)).toEqual([
      win32.join(env.LOCALAPPDATA, 'Programs', 'aiborg', 'Orca.exe'),
      win32.join(env.ProgramFiles, 'AI-Borg', 'Orca.exe')
    ])
    expect(installedElectronCandidates('darwin', '/Users/u', {})).toEqual([
      '/Applications/AI-Borg.app/Contents/MacOS/AI-Borg',
      posix.join('/Users/u', 'Applications', 'AI-Borg.app', 'Contents', 'MacOS', 'AI-Borg')
    ])
    expect(installedElectronCandidates('linux', '/home/u', {})).toEqual(['/opt/AI-Borg/orca-ide'])
  })
})
