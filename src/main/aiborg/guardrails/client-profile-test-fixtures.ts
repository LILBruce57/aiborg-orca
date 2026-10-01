// Guardrail suite fixtures (design §7). Placeholder clients only: acme and contoso.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const ACME = 'acme'
export const CONTOSO = 'contoso'
export const ACME_ORGS = ['acme-inc', 'acme-labs'] as const
export const CONTOSO_ORGS = ['contoso-org'] as const
export const ACME_COLOR = '#2F80ED'
export const CONTOSO_COLOR = '#EB5757'

// Fixture secrets: distinctive strings a whole-tree scan can find, shaped like no real token.
export const FIXTURE_SECRETS = {
  acme: {
    GH_TOKEN: 'fixture-acme-gh-0c1d7e',
    SUPABASE_ACCESS_TOKEN: 'fixture-acme-supabase-5a2b9f',
    ACME_SERVICE_TOKEN: 'fixture-acme-service-77e0aa'
  },
  contoso: {
    GH_TOKEN: 'fixture-contoso-gh-91f3c4',
    CONTOSO_DEPLOY_TOKEN: 'fixture-contoso-deploy-3be812'
  }
} as const

export const ALL_FIXTURE_SECRET_VALUES: readonly string[] = [
  ...Object.values(FIXTURE_SECRETS.acme),
  ...Object.values(FIXTURE_SECRETS.contoso)
]

/** Personal (ambient) credentials the sandbox puts in main's env; none may reach a profile child. */
export const AMBIENT_PERSONAL_ENV = {
  GH_TOKEN: 'ambient-personal-gh-token',
  GITHUB_TOKEN: 'ambient-personal-github-token',
  GH_HOST: 'ambient.example.invalid',
  ANTHROPIC_API_KEY: 'ambient-personal-anthropic',
  ANTHROPIC_AUTH_TOKEN: 'ambient-personal-anthropic-auth',
  CLAUDE_CODE_OAUTH_TOKEN: 'ambient-personal-claude-oauth',
  OPENAI_API_KEY: 'ambient-personal-openai',
  AWS_PROFILE: 'ambient-personal',
  AWS_DEFAULT_PROFILE: 'ambient-personal',
  AWS_ACCESS_KEY_ID: 'ambient-personal-aws-id',
  AWS_SECRET_ACCESS_KEY: 'ambient-personal-aws-secret',
  AWS_SESSION_TOKEN: 'ambient-personal-aws-session',
  AWS_DEFAULT_REGION: 'ap-ambient-1',
  GOOGLE_APPLICATION_CREDENTIALS: '/ambient/personal/gcloud.json',
  SUPABASE_ACCESS_TOKEN: 'ambient-personal-supabase',
  GIT_SSH_COMMAND: 'ssh -i /ambient/personal/id_ed25519'
} as const

export type ProfileJson = Record<string, unknown>

export function acmeProfileJson(overrides: ProfileJson = {}): ProfileJson {
  return {
    schemaVersion: 1,
    id: ACME,
    name: 'Acme',
    color: ACME_COLOR,
    github: {
      host: 'github.com',
      allowedOrgs: [...ACME_ORGS],
      login: 'example-acme-login'
    },
    git: {
      userName: 'Example Acme Dev',
      userEmail: 'dev@acme.example',
      sshPublicKey: 'ssh/id_ed25519.pub',
      includeGlobalGitconfig: false
    },
    aws: { profile: 'acme-dev', region: 'eu-west-1' },
    azure: {},
    gcloud: { project: 'acme-prod-123' },
    secrets: {
      GH_TOKEN: { bitwarden: 'acme / GitHub fine-grained PAT' },
      SUPABASE_ACCESS_TOKEN: { bitwarden: 'acme / Supabase' },
      ACME_SERVICE_TOKEN: { bitwarden: 'acme / Service' }
    },
    env: { ACME_STAGE: 'acme-stage-dev' },
    mcp: {
      claude: {
        'example-server': { command: 'npx', args: ['-y', 'example-mcp'] }
      }
    },
    remote: { allow: false, envAllowlist: [] },
    ...overrides
  }
}

export function contosoProfileJson(overrides: ProfileJson = {}): ProfileJson {
  return {
    schemaVersion: 1,
    id: CONTOSO,
    name: 'Contoso',
    color: CONTOSO_COLOR,
    github: {
      host: 'github.com',
      allowedOrgs: [...CONTOSO_ORGS],
      login: 'example-contoso-login'
    },
    git: {
      userName: 'Example Contoso Dev',
      userEmail: 'dev@contoso.example',
      sshPublicKey: 'ssh/id_ed25519.pub',
      includeGlobalGitconfig: false
    },
    aws: { profile: 'contoso-dev', region: 'eu-central-1' },
    azure: {},
    gcloud: { project: 'contoso-prod-456' },
    secrets: {
      GH_TOKEN: { bitwarden: 'contoso / GitHub fine-grained PAT' },
      CONTOSO_DEPLOY_TOKEN: { bitwarden: 'contoso / Deploy' }
    },
    env: {
      CONTOSO_STAGE: 'contoso-stage-prod',
      CONTOSO_REGION_HINT: 'contoso-emea'
    },
    remote: { allow: false, envAllowlist: [] },
    ...overrides
  }
}

const IDENTIFYING_FACTS = {
  acme: ['acme-stage-dev', 'dev@acme.example', 'acme-dev', 'acme-prod-123', ...ACME_ORGS],
  contoso: [
    'contoso-stage-prod',
    'contoso-emea',
    'dev@contoso.example',
    'contoso-dev',
    'contoso-prod-456',
    ...CONTOSO_ORGS
  ]
} as const

/** Every literal value of a profile that must never appear in another profile's child env. */
export function identifyingValues(profileId: typeof ACME | typeof CONTOSO): string[] {
  return [...Object.values(FIXTURE_SECRETS[profileId]), ...IDENTIFYING_FACTS[profileId]]
}

/** `process.env` without its undefined slots, as a plain child-process env. */
export function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keys of `env` whose value mentions any needle, comparing raw and path-normalised forms. */
export function envKeysMentioning(
  env: Record<string, string | undefined>,
  needles: readonly string[]
): string[] {
  return Object.entries(env)
    .filter(([, value]) =>
      needles.some(
        (needle) =>
          value !== undefined &&
          (value.includes(needle) || comparablePath(value).includes(comparablePath(needle)))
      )
    )
    .map(([key]) => key)
}

/** Paths of every file under `dir` whose bytes contain any of `needles`. */
export function filesContaining(dir: string, needles: readonly string[]): string[] {
  const hits: string[] = []
  const walk = (current: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        // A bare git object store is zlib-compressed; scanning it proves nothing either way.
        if (entry !== 'objects') {
          walk(full)
        }
        continue
      }
      const text = readFileSync(full).toString('utf8')
      if (needles.some((needle) => text.includes(needle))) {
        hits.push(full)
      }
    }
  }
  walk(dir)
  return hits
}

/** Parses a JSONL file; throws on any malformed line. */
export function readJsonLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) {
        throw new Error(`audit line ${index + 1} is not an object: ${line}`)
      }
      return parsed
    })
}

/** Forward slashes and lower case on Windows, so paths compare across spellings. */
export function comparablePath(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/** All keys of `env` that name PATH (Windows keeps `Path`, POSIX `PATH`). */
export function pathKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')
}
