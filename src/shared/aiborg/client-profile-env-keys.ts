/** Env keys a client profile owns (design §3.2). In profile mode every one it does not set is deleted. */
export const CLIENT_PROFILE_MANAGED_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  // Why: gh prefers these over GH_TOKEN for GitHub Enterprise hosts.
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'GIT_CONFIG_GLOBAL',
  'GIT_SSH_COMMAND',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_HOME',
  'ORCA_CODEX_HOME',
  'OPENAI_API_KEY',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AZURE_CONFIG_DIR',
  'AZURE_CORE_ENABLE_BROKER_ON_WINDOWS',
  'CLOUDSDK_CONFIG',
  'CLOUDSDK_CORE_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'SUPABASE_ACCESS_TOKEN'
] as const

/** Keys only AI-Borg derives; a profile's `env` or `secrets` may never name them. */
export const CLIENT_PROFILE_DERIVED_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SSH_AUTH_SOCK',
  'GH_CONFIG_DIR',
  'GH_HOST',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_DIR',
  'GIT_EXEC_PATH',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'ORCA_CODEX_HOME',
  'AWS_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_REGION',
  'AZURE_CONFIG_DIR',
  'AZURE_CORE_ENABLE_BROKER_ON_WINDOWS',
  'CLOUDSDK_CONFIG',
  'CLOUDSDK_CORE_PROJECT'
] as const

export const CLIENT_PROFILE_ENV_PREFIX = 'AIBORG_'

/** Names the restore snippet and audit read back; set alongside the profile values. */
export const CLIENT_PROFILE_IDENTITY_KEYS = {
  id: 'AIBORG_PROFILE_ID',
  name: 'AIBORG_PROFILE_NAME',
  color: 'AIBORG_PROFILE_COLOR',
  allowedOrgs: 'AIBORG_ALLOWED_ORGS',
  keys: 'AIBORG_PROFILE_KEYS',
  unset: 'AIBORG_PROFILE_UNSET',
  bin: 'AIBORG_PROFILE_BIN',
  keepPrefix: 'AIBORG_KEEP_'
} as const

const DERIVED = new Set<string>(CLIENT_PROFILE_DERIVED_ENV_KEYS)

export function isClientProfileDerivedEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  return (
    DERIVED.has(upper) ||
    upper.startsWith(CLIENT_PROFILE_ENV_PREFIX) ||
    upper.startsWith('GIT_CONFIG_')
  )
}
