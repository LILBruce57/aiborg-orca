import { statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { runProcess } from '../../../shared/child-process/run-process'
import type {
  BitwardenImportResult,
  BitwardenStatus
} from '../../../shared/aiborg/client-profile-types'

const BW_TIMEOUT_MS = 30_000

export type BitwardenRunner = typeof runProcess

function readEnvCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const match = Object.keys(env).find((candidate) => candidate.toUpperCase() === key)
  return match ? env[match] : undefined
}

/** Absolute path of `bw` on PATH; spawning a bare name on Windows resolves the cwd first. */
export function findBitwardenCli(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const names = platform === 'win32' ? ['bw.exe', 'bw.cmd'] : ['bw']
  for (const dir of (readEnvCaseInsensitive(env, 'PATH') ?? '').split(delimiter)) {
    for (const name of names) {
      const candidate = dir ? join(dir, name) : ''
      try {
        if (candidate && statSync(candidate).isFile()) {
          return candidate
        }
      } catch {
        // Not here.
      }
    }
  }
  return null
}

export async function readBitwardenStatus(
  env: NodeJS.ProcessEnv = process.env,
  run: BitwardenRunner = runProcess
): Promise<BitwardenStatus> {
  const bw = findBitwardenCli(env)
  if (!bw) {
    return 'unavailable'
  }
  const result = await run({
    program: bw,
    args: ['status', '--nointeraction'],
    env,
    timeoutMs: BW_TIMEOUT_MS
  })
  try {
    const parsed: unknown = JSON.parse(result.stdout)
    const status = parsed && typeof parsed === 'object' && 'status' in parsed ? parsed.status : null
    return status === 'unlocked' || status === 'locked' || status === 'unauthenticated'
      ? status
      : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/**
 * `bw get password <item>` with the unlocked session from BW_SESSION. The value goes straight to
 * the caller (the keychain); it is never logged, and stderr is reduced to a fixed reason.
 */
export async function readBitwardenPassword(
  item: string,
  env: NodeJS.ProcessEnv = process.env,
  run: BitwardenRunner = runProcess
): Promise<{ ok: true; value: string } | Extract<BitwardenImportResult, { ok: false }>> {
  const bw = findBitwardenCli(env)
  if (!bw) {
    return { ok: false, reason: 'bw-missing', message: 'The Bitwarden CLI (bw) is not on PATH.' }
  }
  const result = await run({
    program: bw,
    args: ['get', 'password', item, '--nointeraction'],
    env,
    timeoutMs: BW_TIMEOUT_MS
  })
  const value = result.stdout.replace(/\r?\n$/, '')
  if (result.code === 0 && value.length > 0) {
    return { ok: true, value }
  }
  if (/locked|not logged in|session/i.test(result.stderr)) {
    return {
      ok: false,
      reason: 'bw-locked',
      message:
        'Bitwarden is locked. Unlock it (bw unlock) with BW_SESSION set, or paste the secret.'
    }
  }
  if (/not found/i.test(result.stderr)) {
    return { ok: false, reason: 'not-found', message: 'No Bitwarden item matches that name.' }
  }
  return { ok: false, reason: 'failed', message: 'The Bitwarden CLI could not read that item.' }
}
