import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AIBORG_BRAND } from '../../../shared/aiborg/brand'

const require = createRequire(import.meta.url)
const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const CONFIG_PATH = join(REPO_ROOT, 'config', 'electron-builder.config.cjs')
const UPSTREAM_FLAG = 'AIBORG_UPSTREAM_BEHAVIOR_IN_TESTS'
let savedFlag: string | undefined

type ExtraResource = { from: string; to: string }

function loadPackagedConfig(): Record<string, unknown> & {
  appId: string
  productName: string
  protocols: { schemes: string[] }[]
  extraMetadata: Record<string, unknown>
  nsis: { artifactName: string; include: string }
  dmg: { artifactName: string }
  win: { icon: string; extraResources: ExtraResource[] }
  mac: { icon: string; extraResources: ExtraResource[] }
  linux: { extraResources: ExtraResource[] }
  publish: unknown
} {
  // Why a fresh require: the module evaluates the H1 override once, at load time.
  delete require.cache[require.resolve(CONFIG_PATH)]
  return require(CONFIG_PATH)
}

describe('AI-Borg packaging (H1)', () => {
  beforeEach(() => {
    savedFlag = process.env[UPSTREAM_FLAG]
    delete process.env[UPSTREAM_FLAG]
  })

  afterEach(() => {
    if (savedFlag === undefined) {
      delete process.env[UPSTREAM_FLAG]
    } else {
      process.env[UPSTREAM_FLAG] = savedFlag
    }
    delete require.cache[require.resolve(CONFIG_PATH)]
  })

  it('packages with an identity that cannot collide with stock Orca', () => {
    const config = loadPackagedConfig()
    expect(config.appId).toBe(AIBORG_BRAND.appId)
    expect(config.productName).toBe('AI-Borg')
    expect(config.protocols).toEqual([{ name: 'AI-Borg', schemes: ['aiborg'] }])
    expect(config.extraMetadata.name).toBe('aiborg')
    expect(config.nsis.artifactName).toBe('aiborg-windows-setup.${ext}')
    expect(config.dmg.artifactName).toBe('aiborg-macos-${arch}.${ext}')
    expect(config.publish).toBeNull()
  })

  it('ships LICENSE and NOTICE and uses the AI-Borg icons', () => {
    const config = loadPackagedConfig()
    for (const platform of [config.win, config.mac, config.linux]) {
      expect(platform.extraResources).toEqual(
        expect.arrayContaining([
          { from: 'LICENSE', to: 'LICENSE' },
          { from: 'NOTICE', to: 'NOTICE' }
        ])
      )
    }
    for (const path of [config.win.icon, config.mac.icon, 'NOTICE', 'LICENSE']) {
      expect(existsSync(join(REPO_ROOT, path))).toBe(true)
    }
  })

  it('points the mac CLI launcher at the AI-Borg executable', () => {
    const launcher = loadPackagedConfig().mac.extraResources.find((r) => r.to === 'bin/orca')
    expect(launcher?.from).toBe('resources/aiborg/darwin/bin/orca')
    const script = readFileSync(join(REPO_ROOT, launcher?.from ?? ''), 'utf8')
    expect(script).toContain('ELECTRON="$CONTENTS/MacOS/AI-Borg"')
  })

  it('uninstalls only AI-Borg’s own daemon host, never stock Orca processes or registrations', () => {
    // Why comments are dropped: they name the upstream commands this file deliberately avoids.
    const hooks = readFileSync(loadPackagedConfig().nsis.include, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith(';'))
      .join('\n')
    expect(hooks).toContain(`$LOCALAPPDATA\\${AIBORG_BRAND.daemonHostRootName}\\daemon-host`)
    expect(hooks).not.toMatch(/taskkill/i)
    expect(hooks).not.toContain('Orca.Markdown')
    expect(hooks).not.toContain('$LOCALAPPDATA\\Orca\\')
  })

  it('checks for a running AI-Borg by install path only and fails closed', () => {
    const hooks = readFileSync(loadPackagedConfig().nsis.include, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith(';'))
      .join('\n')
    expect(hooks).toMatch(/!macro customCheckAppRunning\b/)
    // Upstream's check falls back to finding and killing by image name (Orca.exe).
    expect(hooks).not.toContain('orca-process-check.nsh')
    expect(hooks).toContain('StrCpy $IsPowerShellAvailable 0')
    expect(hooks).not.toContain('StrCpy $IsPowerShellAvailable 1')
    expect(hooks).toMatch(/\$0 != 0[\s\S]*Quit[\s\S]*_CHECK_APP_RUNNING/)
  })

  it('keeps upstream values for upstream suites', () => {
    process.env[UPSTREAM_FLAG] = '1'
    expect(loadPackagedConfig().appId).toBe('com.stablyai.orca')
  })
})

describe('check-no-client-data guard', () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aiborg-guard-'))
    writeFileSync(
      join(scratch, 'acme.json'),
      JSON.stringify({ id: 'acme', github: { allowedOrgs: ['acme-inc'] } })
    )
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  function runGuard(message: string): number {
    const messagePath = join(scratch, 'message.txt')
    writeFileSync(messagePath, message)
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'config', 'aiborg', 'check-no-client-data.mjs'), '--message', messagePath],
      { env: { ...process.env, AIBORG_PROFILES_DIR: scratch }, stdio: 'pipe' }
    )
    return result.status ?? -1
  }

  it('rejects a commit message naming a client and accepts one that does not', () => {
    expect(runGuard('Fix push guard for acme-inc')).toBe(1)
    expect(runGuard('Fix push guard')).toBe(0)
  })

  it('matches whole terms only and ignores generic profile values', () => {
    writeFileSync(
      join(scratch, 'xyz.json'),
      JSON.stringify({ id: 'xyz', project: 'main', domain: 'github.com', account: 'dev' })
    )
    expect(runGuard('Update the main branch on github.com for device setup')).toBe(0)
    expect(runGuard('Rename acmes to widgets')).toBe(0)
    expect(runGuard('Move acme_inc fixtures')).toBe(1)
    expect(runGuard('Add XYZ profile')).toBe(1)
  })

  it('fails closed when a profile file cannot be parsed', () => {
    writeFileSync(join(scratch, 'broken.json'), '{ not json')
    expect(runGuard('Fix push guard')).toBe(1)
  })
})
