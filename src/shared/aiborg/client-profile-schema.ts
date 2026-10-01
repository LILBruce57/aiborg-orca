import { z } from 'zod'
import type { ClientProfile } from './client-profile-types'
import { isClientProfileDerivedEnvKey } from './client-profile-env-keys'

export const CLIENT_PROFILE_ID_RE = /^[a-z0-9-]{2,32}$/
export const DEFAULT_CLIENT_PROFILE_SSH_PUBLIC_KEY = 'ssh/id_ed25519.pub'

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const GITHUB_ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const SECRET_LIKE_ENV_KEY_RE = /TOKEN|SECRET|PASSWORD|KEY$/

// Why shapes with a minimum length: real tokens are long, and short look-alikes (`task-sk-1`) are not secrets.
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bsbp_[A-Fa-f0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]

const envRecord = z.record(z.string().regex(ENV_NAME_RE, 'invalid env name'), z.string())

const mcpServer = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: envRecord.optional()
})

const clientProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(CLIENT_PROFILE_ID_RE, 'id must match ^[a-z0-9-]{2,32}$'),
  name: z.string().trim().min(1).max(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb'),
  github: z.strictObject({
    host: z
      .string()
      .regex(/^[a-z0-9.-]+$/, 'invalid host')
      .default('github.com'),
    allowedOrgs: z
      .array(z.string().regex(GITHUB_ORG_RE, 'invalid GitHub org'))
      .min(1, 'allowedOrgs must not be empty'),
    login: z.string().min(1).optional()
  }),
  git: z.strictObject({
    userName: z.string().trim().min(1),
    userEmail: z.string().regex(/^[^\s@]+@[^\s@]+$/, 'invalid email'),
    sshPublicKey: z.string().min(1).optional(),
    includeGlobalGitconfig: z.boolean().optional()
  }),
  aws: z
    .strictObject({ profile: z.string().min(1).optional(), region: z.string().min(1).optional() })
    .optional(),
  azure: z.strictObject({}).optional(),
  gcloud: z.strictObject({ project: z.string().min(1).optional() }).optional(),
  secrets: z
    .record(
      z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'secret names are upper-case env names'),
      z.strictObject({ bitwarden: z.string().min(1).optional() })
    )
    .optional(),
  env: envRecord.optional(),
  mcp: z
    .strictObject({
      claude: z.record(z.string().min(1), mcpServer).optional(),
      codex: z.record(z.string().min(1), mcpServer).optional()
    })
    .optional(),
  remote: z
    .strictObject({ allow: z.boolean(), envAllowlist: z.array(z.string().regex(ENV_NAME_RE)) })
    .optional()
})

export type ClientProfileValidation =
  | { ok: true; profile: ClientProfile }
  | { ok: false; errors: string[] }

/** Paths of every string (key or value) shaped like a credential. */
export function findCredentialLookalikes(value: unknown, path = ''): string[] {
  if (typeof value === 'string') {
    return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value)) ? [path || '(root)'] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findCredentialLookalikes(item, `${path}[${index}]`))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [
      ...findCredentialLookalikes(key, `${path}{key}`),
      ...findCredentialLookalikes(item, path ? `${path}.${key}` : key)
    ])
  }
  return []
}

export function isSecretLikeEnvKey(key: string): boolean {
  return SECRET_LIKE_ENV_KEY_RE.test(key.toUpperCase())
}

/** A profile-relative path that cannot escape the profile home. */
export function isSafeProfileRelativePath(path: string): boolean {
  if (/^[\\/]|^[A-Za-z]:|^~/.test(path)) {
    return false
  }
  return path.split(/[\\/]/).every((part) => part !== '..' && part !== '')
}

function semanticErrors(profile: ClientProfile, fileName: string | undefined): string[] {
  const errors: string[] = []
  const expectedId = fileName?.replace(/\.json$/i, '')
  if (expectedId !== undefined && profile.id !== expectedId) {
    errors.push(`id "${profile.id}" must equal the file name "${expectedId}"`)
  }
  if (profile.git.sshPublicKey && !isSafeProfileRelativePath(profile.git.sshPublicKey)) {
    errors.push('git.sshPublicKey must be a relative path inside the profile home')
  }
  const envMaps: [string, Record<string, string> | undefined][] = [
    ['env', profile.env],
    ...Object.entries(profile.mcp?.claude ?? {}).map(
      ([name, server]): [string, Record<string, string> | undefined] => [
        `mcp.claude.${name}.env`,
        server.env
      ]
    ),
    ...Object.entries(profile.mcp?.codex ?? {}).map(
      ([name, server]): [string, Record<string, string> | undefined] => [
        `mcp.codex.${name}.env`,
        server.env
      ]
    )
  ]
  for (const [where, map] of envMaps) {
    for (const key of Object.keys(map ?? {})) {
      if (isSecretLikeEnvKey(key)) {
        errors.push(`${where}.${key} looks like a secret; move it to "secrets"`)
      } else if (where === 'env' && isClientProfileDerivedEnvKey(key)) {
        errors.push(`env.${key} is managed by AI-Borg`)
      }
    }
  }
  for (const key of Object.keys(profile.secrets ?? {})) {
    if (isClientProfileDerivedEnvKey(key)) {
      errors.push(`secrets.${key} is managed by AI-Borg`)
    }
    if (profile.env && key in profile.env) {
      errors.push(`${key} is both a secret and a plain env value`)
    }
  }
  for (const key of profile.remote?.envAllowlist ?? []) {
    if (!profile.env || !(key in profile.env)) {
      errors.push(`remote.envAllowlist: ${key} is not a plain env key of this profile`)
    }
  }
  return errors
}

/** Validates one profile file; `fileName` (with or without `.json`) must equal the id. */
export function validateClientProfile(raw: unknown, fileName?: string): ClientProfileValidation {
  const secretPaths = findCredentialLookalikes(raw)
  const parsed = clientProfileSchema.safeParse(raw)
  const errors = secretPaths.map(
    (path) => `${path}: looks like a secret value; use a "secrets" reference`
  )
  if (!parsed.success) {
    errors.push(
      ...parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    )
    return { ok: false, errors }
  }
  const profile: ClientProfile = {
    ...parsed.data,
    github: {
      ...parsed.data.github,
      allowedOrgs: [...new Set(parsed.data.github.allowedOrgs.map((org) => org.toLowerCase()))]
    }
  }
  errors.push(...semanticErrors(profile, fileName))
  return errors.length > 0 ? { ok: false, errors } : { ok: true, profile }
}

/** Orgs listed in more than one profile, with the ids that claim each. */
export function findDuplicateAllowedOrgs(
  profiles: readonly Pick<ClientProfile, 'id' | 'github'>[]
): Map<string, string[]> {
  const claims = new Map<string, string[]>()
  for (const profile of profiles) {
    for (const org of profile.github.allowedOrgs) {
      const key = `${profile.github.host}/${org.toLowerCase()}`
      claims.set(key, [...(claims.get(key) ?? []), profile.id])
    }
  }
  return new Map([...claims].filter(([, ids]) => ids.length > 1))
}

/** Cross-profile errors (an org claimed twice); empty when the set is valid. */
export function validateClientProfileSet(
  profiles: readonly Pick<ClientProfile, 'id' | 'github'>[]
): string[] {
  return [...findDuplicateAllowedOrgs(profiles)].map(
    ([org, ids]) => `org ${org} is listed in more than one profile: ${ids.join(', ')}`
  )
}

/** The profile whose `allowedOrgs` contains this remote owner, if exactly one does. */
export function findClientProfileForOwner<T extends Pick<ClientProfile, 'github'>>(
  profiles: readonly T[],
  host: string,
  owner: string
): T | null {
  const normalizedOwner = owner.toLowerCase()
  const matches = profiles.filter(
    (profile) =>
      profile.github.host === host.toLowerCase() &&
      profile.github.allowedOrgs.includes(normalizedOwner)
  )
  return matches.length === 1 ? matches[0] : null
}

export function isOwnerAllowedForClientProfile(
  profile: Pick<ClientProfile, 'github'>,
  host: string,
  owner: string
): boolean {
  return (
    profile.github.host === host.toLowerCase() &&
    profile.github.allowedOrgs.includes(owner.toLowerCase())
  )
}

export function clientProfileSshPublicKeyPath(profile: Pick<ClientProfile, 'git'>): string {
  return profile.git.sshPublicKey ?? DEFAULT_CLIENT_PROFILE_SSH_PUBLIC_KEY
}
