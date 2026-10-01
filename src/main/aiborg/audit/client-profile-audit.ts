import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ClientProfileAuditEvent } from '../../../shared/aiborg/client-profile-types'
import {
  clientProfileHomeLayout,
  resolveClientProfilesRoot
} from '../profiles/client-profile-paths'
import { getClientProfileRuntime } from '../profiles/client-profile-runtime'

export const CLIENT_PROFILE_AUDIT_ROTATE_BYTES = 5 * 1024 * 1024

export type ClientProfileAuditFieldValue = string | number | boolean | null

// Why: callers pass names and ids only; a field named like a value is dropped, not written.
const FORBIDDEN_FIELD_RE = /value|token|secret|password|credential/i

export function formatClientProfileAuditLine(
  event: ClientProfileAuditEvent,
  profileId: string,
  fields: Record<string, ClientProfileAuditFieldValue | undefined> = {},
  now: Date = new Date()
): string {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) =>
        value !== undefined && !FORBIDDEN_FIELD_RE.test(key) && key !== 'ts' && key !== 'event'
    )
  )
  return `${JSON.stringify({ ts: now.toISOString(), event, profileId, ...safeFields })}\n`
}

function rotateIfLarge(auditPath: string): void {
  try {
    if (statSync(auditPath).size >= CLIENT_PROFILE_AUDIT_ROTATE_BYTES) {
      renameSync(auditPath, join(dirname(auditPath), 'audit-1.jsonl'))
    }
  } catch {
    // No file yet.
  }
}

/** Appends one line to P/audit.jsonl. Never throws: auditing must not mask the guarded outcome. */
export function appendClientProfileAudit(
  profileId: string,
  event: ClientProfileAuditEvent,
  fields: Record<string, ClientProfileAuditFieldValue | undefined> = {},
  root: string = getClientProfileRuntime()?.root ?? resolveClientProfilesRoot()
): void {
  try {
    const { home, audit } = clientProfileHomeLayout(root, profileId)
    if (!existsSync(home)) {
      mkdirSync(home, { recursive: true })
    }
    rotateIfLarge(audit)
    appendFileSync(audit, formatClientProfileAuditLine(event, profileId, fields), 'utf8')
  } catch (error) {
    console.warn(
      '[aiborg] client profile audit write failed',
      error instanceof Error ? error.message : error
    )
  }
}
