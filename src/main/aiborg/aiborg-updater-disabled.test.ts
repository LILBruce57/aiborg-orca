import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from '../updater-test-module-loader'

const {
  appMock,
  autoUpdaterMock,
  powerMonitorOnMock,
  fetchNudgeMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () => (await import('../updater-test-harness')).createUpdaterMocks())

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('../electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => moduleFactories.electronToolkitUtils())
vi.mock('../ipc/pty', () => moduleFactories.ipcPty())
vi.mock('../linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('../updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('../updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('../updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('../update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('../updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('../local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('../local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

warmUpdaterModule()

const UPSTREAM_FLAG = 'AIBORG_UPSTREAM_BEHAVIOR_IN_TESTS'
let savedFlag: string | undefined

describe('AI-Borg updater (T19)', () => {
  beforeEach(() => {
    savedFlag = process.env[UPSTREAM_FLAG]
    delete process.env[UPSTREAM_FLAG]
    resetUpdaterMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (savedFlag === undefined) {
      delete process.env[UPSTREAM_FLAG]
    } else {
      process.env[UPSTREAM_FLAG] = savedFlag
    }
  })

  it('never configures a feed, checks, or fetches the nudge in a packaged build', async () => {
    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater } = await loadUpdaterModule()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the updater only calls webContents.send on this window.
    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000
    })
    appMock.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000)

    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(fetchNudgeMock).not.toHaveBeenCalled()
    expect(powerMonitorOnMock).not.toHaveBeenCalled()
  })

  it('answers a manual check with not-available and no network call', async () => {
    const send = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the updater only calls webContents.send on this window.
    setupAutoUpdater({ webContents: { send } } as never)

    checkForUpdatesFromMenu()

    expect(send).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('lists no upstream release builds', async () => {
    const { listAvailableReleaseBuilds } = await loadUpdaterModule()
    await expect(listAvailableReleaseBuilds('stable')).resolves.toEqual([])
  })
})
