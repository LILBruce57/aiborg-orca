// T17 (design §5.5, invariant 6). Needs the Phase 2/3 implementation.
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACME,
  ALL_FIXTURE_SECRET_VALUES,
  CONTOSO,
  filesContaining,
  readJsonLines
} from './client-profile-test-fixtures'
import { clientProfiles } from './client-profile-test-harness'
import { daemonChildEnv, headlessSpawn, rendererSpawn } from './client-profile-spawn-test-harness'
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

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const

describe('T17 audit log', () => {
  let world: ClientProfileWorld
  let consoleText: () => string

  beforeEach(async () => {
    const spies = CONSOLE_METHODS.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    )
    consoleText = () =>
      spies
        .flatMap((spy) => spy.mock.calls.flat())
        .map((arg) => String(arg))
        .join('\n')
    world = await createClientProfileWorld({ active: null })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await world.dispose()
  })

  const auditPath = (id: string) => join(world.profileHome(id), 'audit.jsonl')

  it('writes well-formed JSONL with ts, event and profileId on every line', async () => {
    await clientProfiles.activate(ACME)
    await rendererSpawn({ worktreeId: world.worktreeIds.acme, env: {} })
    clientProfiles.audit(ACME, 'repo.mismatch.shown', {
      repoId: world.repos.contoso.id
    })
    const lines = readJsonLines(auditPath(ACME))
    expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const line of lines) {
      expect(typeof line.event).toBe('string')
      expect(line.profileId).toBe(ACME)
      expect(Number.isNaN(Date.parse(String(line.ts)))).toBe(false)
    }
    const events = lines.map((line) => line.event)
    expect(events).toEqual(
      expect.arrayContaining(['profile.activate', 'terminal.spawn', 'repo.mismatch.shown'])
    )
    expect(events).toContain('secret.set')
  })

  it('never writes a secret value to disk or logs, whatever the flow does', async () => {
    await clientProfiles.activate(ACME)
    daemonChildEnv(await rendererSpawn({ worktreeId: world.worktreeIds.acme, env: {} }))
    await expect(
      rendererSpawn({ worktreeId: world.worktreeIds.contoso, env: {} })
    ).rejects.toThrow()
    daemonChildEnv(await headlessSpawn({ worktreeId: world.worktreeIds.contoso, env: {} }))
    await clientProfiles.keychain.setSecret(ACME, 'GH_TOKEN', 'fixture-acme-gh-rotated-4d5e6f')
    await clientProfiles.keychain.deleteSecret(CONTOSO, 'CONTOSO_DEPLOY_TOKEN')
    await clientProfiles.activate(CONTOSO)
    await clientProfiles.activate(null)

    const needles = [...ALL_FIXTURE_SECRET_VALUES, 'fixture-acme-gh-rotated-4d5e6f']
    expect(filesContaining(world.sandbox.root, needles)).toEqual([])
    const logged = consoleText()
    for (const needle of needles) {
      expect(logged).not.toContain(needle)
    }
    const secretEvents = readJsonLines(auditPath(ACME)).filter(
      (line) => line.event === 'secret.set'
    )
    expect(secretEvents.some((line) => line.name === 'GH_TOKEN')).toBe(true)
  })

  it('rotates to audit-1.jsonl once the file passes 5 MB', () => {
    const padding = 'x'.repeat(64 * 1024)
    for (let index = 0; index < 90; index++) {
      clientProfiles.audit(ACME, 'terminal.spawn', {
        ptyId: `pty-${index}`,
        padding
      })
    }
    expect(existsSync(join(world.profileHome(ACME), 'audit-1.jsonl'))).toBe(true)
    expect(statSync(auditPath(ACME)).size).toBeLessThan(5 * 1024 * 1024)
    readJsonLines(auditPath(ACME))
  })
})
