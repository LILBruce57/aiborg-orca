import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import {
  findBitwardenCli,
  readBitwardenPassword,
  readBitwardenStatus
} from './bitwarden-secret-import'

const temps: string[] = []
function fakeBwDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiborg-bw-'))
  temps.push(dir)
  writeFileSync(join(dir, process.platform === 'win32' ? 'bw.exe' : 'bw'), '')
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function result(partial: Partial<ProcessResult>): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...partial }
}

describe('Bitwarden import', () => {
  it('finds bw by absolute path on PATH (case-insensitive key on Windows)', () => {
    const dir = fakeBwDir()
    expect(findBitwardenCli({ Path: dir }, process.platform)).toBe(
      join(dir, process.platform === 'win32' ? 'bw.exe' : 'bw')
    )
    expect(findBitwardenCli({ PATH: join(dir, 'missing') }, process.platform)).toBeNull()
  })

  it('reports a missing CLI without spawning', async () => {
    const run = vi.fn()
    expect(await readBitwardenPassword('acme / GitHub', { PATH: '' }, run)).toMatchObject({
      ok: false,
      reason: 'bw-missing'
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('passes the item as one argv entry and strips the trailing newline', async () => {
    const dir = fakeBwDir()
    const run = vi.fn(async (_spec: ProcessSpec) => result({ stdout: 'fixture-value\n' }))
    const read = await readBitwardenPassword('acme / GitHub', { PATH: dir }, run)
    expect(read).toEqual({ ok: true, value: 'fixture-value' })
    expect(run.mock.calls[0][0].args).toEqual([
      'get',
      'password',
      'acme / GitHub',
      '--nointeraction'
    ])
  })

  it('maps locked and not-found errors to fixed messages', async () => {
    const dir = fakeBwDir()
    const locked = vi.fn(async () => result({ code: 1, stderr: 'Vault is locked.' }))
    const missing = vi.fn(async () => result({ code: 1, stderr: 'Not found.' }))
    expect(await readBitwardenPassword('x', { PATH: dir }, locked)).toMatchObject({
      reason: 'bw-locked'
    })
    expect(await readBitwardenPassword('x', { PATH: dir }, missing)).toMatchObject({
      reason: 'not-found'
    })
  })

  it('reads the vault status', async () => {
    const dir = fakeBwDir()
    const run = vi.fn(async () => result({ stdout: '{"status":"unlocked"}' }))
    expect(await readBitwardenStatus({ PATH: dir }, run)).toBe('unlocked')
    expect(await readBitwardenStatus({ PATH: '' }, run)).toBe('unavailable')
  })
})
