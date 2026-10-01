import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import type { ClientProfileSetupTool } from './new-client-profile-form'

// Why so strict: these values are typed into PowerShell, bash or zsh; anything else is refused.
const SHELL_SAFE_WORD_RE = /^[A-Za-z0-9._@+-]+$/
const SHELL_SAFE_PATH_RE = /^[A-Za-z0-9._@+\-/\\: ]+$/

function shellSafeWord(value: string | undefined): string | null {
  return value && SHELL_SAFE_WORD_RE.test(value) ? value : null
}

export const GH_VERIFY_COMMAND = 'gh api user --jq .login'

/** The interactive login each tool needs; it runs in a setup terminal bound to the profile. */
export function loginCommandFor(
  tool: ClientProfileSetupTool,
  profile: Pick<ClientProfile, 'github' | 'aws'>
): string | null {
  switch (tool) {
    case 'gh': {
      const host = shellSafeWord(profile.github.host)
      // Why --insecure-storage: gh's keyring entry is keyed by host only, so every GH_CONFIG_DIR
      // (each profile and the personal one) would share it; this keeps the token in P/gh.
      return host ? `gh auth login --hostname ${host} --git-protocol ssh --insecure-storage` : null
    }
    case 'claude':
      return 'claude'
    case 'codex':
      return 'codex login'
    case 'aws': {
      const awsProfile = shellSafeWord(profile.aws?.profile)
      return awsProfile ? `aws configure sso --profile ${awsProfile}` : null
    }
    case 'azure':
      return 'az login'
    case 'gcloud':
      return 'gcloud auth login'
    case 'supabase':
      return null
  }
}

/** `ssh-keygen` for a new key at `privateKeyPath`; null when either value is not shell-safe. */
export function sshKeygenCommand(email: string, privateKeyPath: string): string | null {
  if (!shellSafeWord(email) || !SHELL_SAFE_PATH_RE.test(privateKeyPath)) {
    return null
  }
  return `ssh-keygen -t ed25519 -C "${email}" -f "${privateKeyPath}"`
}
