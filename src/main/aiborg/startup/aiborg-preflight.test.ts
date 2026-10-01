import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

import { applyAiborgTelemetryKillSwitch, resolveAiborgUserDataPath } from './aiborg-preflight'

describe('resolveAiborgUserDataPath', () => {
  it('pins packaged builds to the aiborg folder under appData', () => {
    expect(
      resolveAiborgUserDataPath({
        isDev: false,
        e2eUserDataDir: null,
        getAppDataPath: () => join('home', 'AppData', 'Roaming')
      })
    ).toBe(join('home', 'AppData', 'Roaming', 'aiborg'))
  })

  it('leaves dev and E2E launches to upstream path logic without reading appData', () => {
    const getAppDataPath = vi.fn(() => 'unused')
    expect(resolveAiborgUserDataPath({ isDev: true, e2eUserDataDir: null, getAppDataPath })).toBe(
      null
    )
    expect(
      resolveAiborgUserDataPath({ isDev: false, e2eUserDataDir: 'e2e-profile', getAppDataPath })
    ).toBe(null)
    expect(getAppDataPath).not.toHaveBeenCalled()
  })
})

describe('applyAiborgTelemetryKillSwitch', () => {
  it('disables Orca product telemetry by default', () => {
    const env: NodeJS.ProcessEnv = {}
    applyAiborgTelemetryKillSwitch(env)
    expect(env.ORCA_TELEMETRY_DISABLED).toBe('1')
  })

  it('keeps an explicit value', () => {
    const env: NodeJS.ProcessEnv = { ORCA_TELEMETRY_DISABLED: 'true' }
    applyAiborgTelemetryKillSwitch(env)
    expect(env.ORCA_TELEMETRY_DISABLED).toBe('true')
  })
})
