import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock, ghExecFileAsyncMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) }
}))

vi.mock('../github/gh-utils', () => ({
  ghExecFileAsync: (...args: unknown[]) => ghExecFileAsyncMock(...args),
  acquire: vi.fn(async () => {}),
  release: vi.fn()
}))

import {
  assertAiborgCloudSharingAllowed,
  assertAiborgFeedbackAllowed,
  assertAiborgGlobalCliRegistrationAllowed,
  brandedOrUpstream,
  isAiborgAutoUpdateDisabled,
  isAiborgGlobalCliRegistrationDisabled,
  isAiborgPushRelayDisabled,
  isAiborgUpstreamStarDisabled,
  isUpstreamBehaviorUnderTest
} from './upstream-service-policy'
import { postFeedback } from '../ipc/feedback-request'
import { checkOrcaStarred, starOrca } from '../github/client/fetch/orca-star'
import { CliInstaller } from '../cli/cli-installer'
import { WslCliInstaller } from '../cli/wsl-cli-installer'
import { reconcileManagedWslCliRegistrations } from '../cli/wsl-cli-registration-reconciliation'
import { resolveArtifactCloudApiUrl } from '../artifacts/artifact-cloud-config'
import { skillCloudRequest } from '../skills/skill-cloud-request'
import { DesktopPushService } from '../runtime/push/desktop-push-service'

const UPSTREAM_FLAG = 'AIBORG_UPSTREAM_BEHAVIOR_IN_TESTS'
let savedFlag: string | undefined

beforeEach(() => {
  // Why: the global Vitest setup runs upstream suites in upstream mode; these assert the fork.
  savedFlag = process.env[UPSTREAM_FLAG]
  delete process.env[UPSTREAM_FLAG]
  fetchMock.mockReset()
  ghExecFileAsyncMock.mockReset()
})

afterEach(() => {
  if (savedFlag === undefined) {
    delete process.env[UPSTREAM_FLAG]
  } else {
    process.env[UPSTREAM_FLAG] = savedFlag
  }
})

describe('AI-Borg upstream service switches (T19)', () => {
  it('turns updates, the star call, global CLI registration, sharing and push off by default', () => {
    expect(isAiborgAutoUpdateDisabled()).toBe(true)
    expect(isAiborgUpstreamStarDisabled()).toBe(true)
    expect(isAiborgGlobalCliRegistrationDisabled()).toBe(true)
    expect(isAiborgPushRelayDisabled()).toBe(true)
    expect(() => assertAiborgFeedbackAllowed()).toThrow(/disabled in AI-Borg/)
    expect(() => assertAiborgGlobalCliRegistrationAllowed()).toThrow(/global `orca` command/)
    expect(() => assertAiborgCloudSharingAllowed()).toThrow(/disabled in AI-Borg/)
  })

  it('resolves brand data to AI-Borg outside the upstream test seam', () => {
    expect(brandedOrUpstream('AI-Borg', 'Orca')).toBe('AI-Borg')
    process.env[UPSTREAM_FLAG] = '1'
    expect(brandedOrUpstream('AI-Borg', 'Orca')).toBe('Orca')
  })

  it('restores upstream behaviour only under Vitest with the explicit flag', () => {
    expect(isUpstreamBehaviorUnderTest({ VITEST: 'true', [UPSTREAM_FLAG]: '1' })).toBe(true)
    expect(isUpstreamBehaviorUnderTest({ [UPSTREAM_FLAG]: '1' })).toBe(false)
    expect(isUpstreamBehaviorUnderTest({ VITEST: 'true' })).toBe(false)
  })

  it('compiles product telemetry out of the main process', () => {
    const clientSource = readFileSync(join(__dirname, '..', 'telemetry', 'client.ts'), 'utf8')
    // Same shape config/scripts/verify-telemetry-constants.mjs parses.
    expect(/^const\s+TELEMETRY_ENABLED\s*=\s*(true|false)/m.exec(clientSource)?.[1]).toBe('false')
  })
})

describe('AI-Borg hooks at upstream call sites', () => {
  it('refuses feedback before any network request', async () => {
    await expect(
      postFeedback('https://feedback.invalid', {
        feedback: 'x',
        submissionType: 'feedback',
        githubLogin: null,
        githubEmail: null,
        appVersion: '1.2.3',
        platform: 'win32',
        osRelease: '10',
        arch: 'x64'
      })
    ).rejects.toThrow(/disabled in AI-Borg/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never runs gh for the upstream star check or PUT', async () => {
    await expect(checkOrcaStarred()).resolves.toBeNull()
    await expect(starOrca()).resolves.toBe(false)
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('refuses global CLI registration without touching the Windows PATH', async () => {
    const userPathWriter = vi.fn(async () => {})
    const installer = new CliInstaller({
      platform: 'win32',
      isPackaged: true,
      userDataPath: join('fixture', 'userData'),
      resourcesPath: join('fixture', 'resources'),
      execPath: join('fixture', 'AI-Borg.exe'),
      appPath: join('fixture', 'app'),
      homePath: join('fixture', 'home'),
      localAppDataPath: join('fixture', 'local'),
      processPathEnv: '',
      userPathWriter
    })
    await expect(installer.install()).rejects.toThrow(/global `orca` command/)
    expect(userPathWriter).not.toHaveBeenCalled()
  })

  it('refuses to remove a global command that may be stock Orca’s', async () => {
    const userPathWriter = vi.fn(async () => {})
    const installer = new CliInstaller({
      platform: 'win32',
      isPackaged: true,
      userDataPath: join('fixture', 'userData'),
      resourcesPath: join('fixture', 'resources'),
      execPath: join('fixture', 'AI-Borg.exe'),
      appPath: join('fixture', 'app'),
      homePath: join('fixture', 'home'),
      localAppDataPath: join('fixture', 'local'),
      processPathEnv: '',
      userPathWriter
    })
    await expect(installer.remove()).rejects.toThrow(/global `orca` command/)
    expect(userPathWriter).not.toHaveBeenCalled()
  })

  it('refuses WSL launcher install and removal without running anything in the distro', async () => {
    const wslRunner = vi.fn(async () => '')
    const getStatus = vi.fn()
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus },
      wslRunner
    })
    await expect(installer.remove()).rejects.toThrow(/global `orca` command/)
    await expect(installer.install()).rejects.toThrow(/global `orca` command/)
    expect(wslRunner).not.toHaveBeenCalled()
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('refuses artifact and skill cloud requests before any network call', async () => {
    expect(() => resolveArtifactCloudApiUrl(undefined, {}, true)).toThrow(/disabled in AI-Borg/)
    const fetcher = vi.fn()
    await expect(skillCloudRequest({ path: '/v1/skills', fetcher })).rejects.toThrow(
      /disabled in AI-Borg/
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('never builds the push.onorca.dev relay client', () => {
    const getE2EEKeypair = vi.fn()
    const service = DesktopPushService.create({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create returns before reading runtime; the spy proves runtimeRpc is untouched too.
      runtime: {} as Parameters<typeof DesktopPushService.create>[0]['runtime'],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only getE2EEKeypair would be read first, and the test asserts it never is.
      runtimeRpc: { getE2EEKeypair } as unknown as Parameters<
        typeof DesktopPushService.create
      >[0]['runtimeRpc'],
      gatewayUrl: 'https://push.onorca.dev'
    })
    expect(service).toBeNull()
    expect(getE2EEKeypair).not.toHaveBeenCalled()
  })

  it('skips the startup WSL launcher repair entirely', async () => {
    const listDistros = vi.fn(async () => ['Ubuntu'])
    await expect(
      reconcileManagedWslCliRegistrations({
        platform: 'win32',
        isPackaged: true,
        userDataPath: join('fixture', 'userData'),
        listDistros
      })
    ).resolves.toEqual([])
    expect(listDistros).not.toHaveBeenCalled()
  })
})
