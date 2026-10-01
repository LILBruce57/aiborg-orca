import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CLIENT_PROFILE_ID_RE } from '../../../shared/aiborg/client-profile-schema'

/** Overrides `~/.aiborg/profiles`; tests and smoke runs point it at a temp dir. */
export const AIBORG_PROFILES_ROOT_ENV = 'AIBORG_PROFILES_ROOT'
/** Overrides the sidecar `profilesDir` (the private `clients/` folder). */
export const AIBORG_PROFILES_DIR_ENV = 'AIBORG_PROFILES_DIR'

export type ClientProfileHomeLayout = {
  home: string
  gh: string
  claude: string
  codex: string
  aws: string
  awsConfig: string
  awsCredentials: string
  azure: string
  gcloud: string
  ssh: string
  sshConfig: string
  mcp: string
  hooks: string
  bin: string
  gitconfig: string
  audit: string
}

export const CLIENT_PROFILE_TOOL_DIRS = [
  'gh',
  'claude',
  'codex',
  'aws',
  'azure',
  'gcloud',
  'ssh',
  'mcp',
  'hooks',
  'bin'
] as const

export function resolveClientProfilesRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const override = env[AIBORG_PROFILES_ROOT_ENV]?.trim()
  // Why resolve: CLAUDE_CONFIG_DIR must be spelled identically every time (macOS keychain item name).
  return resolve(override ? override : join(home, '.aiborg', 'profiles'))
}

export function resolveClientProfileAuditArchiveDir(root: string): string {
  return join(dirname(root), 'audit-archive')
}

export function clientProfileHomeLayout(root: string, profileId: string): ClientProfileHomeLayout {
  // Why: the id becomes a path segment; the regex rules out separators and `..`.
  if (!CLIENT_PROFILE_ID_RE.test(profileId)) {
    throw new Error(`Invalid client profile id: ${JSON.stringify(profileId)}`)
  }
  const home = join(root, profileId)
  return {
    home,
    gh: join(home, 'gh'),
    claude: join(home, 'claude'),
    codex: join(home, 'codex'),
    aws: join(home, 'aws'),
    awsConfig: join(home, 'aws', 'config'),
    awsCredentials: join(home, 'aws', 'credentials'),
    azure: join(home, 'azure'),
    gcloud: join(home, 'gcloud'),
    ssh: join(home, 'ssh'),
    sshConfig: join(home, 'ssh', 'config'),
    mcp: join(home, 'mcp'),
    hooks: join(home, 'hooks'),
    bin: join(home, 'bin'),
    gitconfig: join(home, 'gitconfig'),
    audit: join(home, 'audit.jsonl')
  }
}

/** Forward-slash form for gitconfig values and sh scripts, where `\` is an escape. */
export function toGitPath(path: string): string {
  return path.replaceAll('\\', '/')
}
