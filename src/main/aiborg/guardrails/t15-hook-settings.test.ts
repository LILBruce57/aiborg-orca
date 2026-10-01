// T15 (design §4.3, H35). Temp HOME only. Needs the Phase 2 implementation.
// The statusline may be installed per directory or skipped for profiles (both allowed by §4.3);
// either way a profile directory must not inherit the personal opt-out, and vice versa.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeHookService } from '../../claude/hook-service'
import { ACME, CONTOSO, isRecord } from './client-profile-test-fixtures'
import { clientProfiles } from './client-profile-test-harness'
import {
  createClientProfileWorld,
  type ClientProfileWorld
} from './client-profile-world-test-harness'

vi.mock(
  'electron',
  async () => (await import('./client-profile-electron-test-fixture')).electronModule
)
vi.mock(
  '@napi-rs/keyring',
  async () => (await import('./client-profile-keyring-test-fixture')).keyringModule
)

const CLAUDE_VERSION = '2.1.261'

function readSettings(configDir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
  return isRecord(parsed) ? parsed : {}
}

describe('T15 hook settings per CLAUDE_CONFIG_DIR', () => {
  let world: ClientProfileWorld
  let personalDir: string
  let acmeDir: string
  let contosoDir: string

  beforeEach(async () => {
    world = await createClientProfileWorld({ active: null })
    personalDir = join(world.sandbox.home, '.claude')
    acmeDir = join(world.profileHome(ACME), 'claude')
    contosoDir = join(world.profileHome(CONTOSO), 'claude')
  })

  afterEach(async () => world.dispose())

  it('install({configDir}) writes <dir>/settings.json and leaves ~/.claude/settings.json untouched', () => {
    const service = new ClaudeHookService()
    service.install({ claudeVersion: CLAUDE_VERSION, configDir: acmeDir })
    expect(isRecord(readSettings(acmeDir).hooks)).toBe(true)
    expect(existsSync(join(personalDir, 'settings.json'))).toBe(false)
    expect(service.getStatus({ configDir: acmeDir }).state).toBe('installed')
    expect(service.getStatus().state).not.toBe('installed')
  })

  it('remove({configDir}) only touches that directory', () => {
    const service = new ClaudeHookService()
    service.install({ claudeVersion: CLAUDE_VERSION })
    service.install({ claudeVersion: CLAUDE_VERSION, configDir: acmeDir })
    service.remove({ configDir: acmeDir })
    expect(service.getStatus({ configDir: acmeDir }).state).not.toBe('installed')
    expect(service.getStatus().state).toBe('installed')
  })

  it('a personal statusline opt-out does not suppress a fresh profile directory, and vice versa', () => {
    const service = new ClaudeHookService()
    service.install({ claudeVersion: CLAUDE_VERSION })
    const { statusLine: _optedOut, ...rest } = readSettings(personalDir)
    writeFileSync(join(personalDir, 'settings.json'), JSON.stringify(rest))

    service.install({ claudeVersion: CLAUDE_VERSION, configDir: acmeDir })
    const acmeStatusLine = readSettings(acmeDir).statusLine
    if (acmeStatusLine !== undefined) {
      // Per-directory marker: acme installs its own; opting out in acme leaves contoso alone.
      const { statusLine: _acmeOptOut, ...acmeRest } = readSettings(acmeDir)
      writeFileSync(join(acmeDir, 'settings.json'), JSON.stringify(acmeRest))
      service.install({ claudeVersion: CLAUDE_VERSION, configDir: acmeDir })
      expect(readSettings(acmeDir).statusLine).toBeUndefined()
      service.install({ claudeVersion: CLAUDE_VERSION, configDir: contosoDir })
      expect(readSettings(contosoDir).statusLine).toBeDefined()
    }
    // The personal opt-out survives whatever the profiles did.
    service.install({ claudeVersion: CLAUDE_VERSION })
    expect(readSettings(personalDir).statusLine).toBeUndefined()
  })

  it('activation installs Orca’s status hooks into P/claude', async () => {
    await clientProfiles.activate(ACME)
    expect(isRecord(readSettings(acmeDir).hooks)).toBe(true)
    expect(existsSync(join(personalDir, 'settings.json'))).toBe(false)
  })
})
