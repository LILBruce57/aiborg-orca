import { app } from 'electron'
import { join } from 'node:path'
import { AIBORG_BRAND } from '../../../shared/aiborg/brand'
import { getMainE2EConfig } from '../../e2e-config'

/** Packaged userData for AI-Borg, or null when upstream's dev/E2E path logic must decide. */
export function resolveAiborgUserDataPath(options: {
  isDev: boolean
  e2eUserDataDir: string | null
  getAppDataPath: () => string
}): string | null {
  if (options.isDev || options.e2eUserDataDir) {
    return null
  }
  return join(options.getAppDataPath(), AIBORG_BRAND.userDataDirName)
}

/** Orca's product-telemetry kill switch; keeps local logs, disables any upload. */
export function applyAiborgTelemetryKillSwitch(env: NodeJS.ProcessEnv): void {
  env.ORCA_TELEMETRY_DISABLED ??= '1'
}

/**
 * Runs first in main-process preflight (hooks H3/H4), before anything resolves userData.
 *
 * Why set userData explicitly: Electron otherwise derives it from the packaged package.json, and a
 * stock Orca's %APPDATA%\orca must never be shared (single-instance lock, stores, runtime pointer).
 */
export function aiborgPreflight(isDev: boolean): void {
  // Why process.env: the flag also reaches child terminals and the bundled CLI.
  applyAiborgTelemetryKillSwitch(process.env)
  const userDataPath = resolveAiborgUserDataPath({
    isDev,
    e2eUserDataDir: getMainE2EConfig().userDataDir,
    getAppDataPath: () => app.getPath('appData')
  })
  if (userDataPath) {
    app.setPath('userData', userDataPath)
  }
}
