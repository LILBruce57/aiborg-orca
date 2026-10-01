import { deleteActiveClaudeKeychainCredentialsStrict } from '../../claude-accounts/keychain'

export type ClientProfileClaudeKeychainDeps = {
  platform: NodeJS.Platform
  /** Only the item scoped to this config dir (and its realpath aliases), never the default one. */
  deleteScoped: (claudeConfigDir: string) => Promise<void>
}

const defaultDeps: ClientProfileClaudeKeychainDeps = {
  platform: process.platform,
  deleteScoped: deleteActiveClaudeKeychainCredentialsStrict
}

/**
 * Delete flow: on macOS Claude Code keeps a CLAUDE_CONFIG_DIR login in a login-Keychain item
 * named after a hash of that path. Wiping P/claude leaves it, and a new profile with the same
 * id (same path, same hash) would start signed in as the old client account.
 */
export async function deleteClientProfileClaudeCredentials(
  claudeConfigDir: string,
  deps: ClientProfileClaudeKeychainDeps = defaultDeps
): Promise<void> {
  if (deps.platform !== 'darwin') {
    return
  }
  await deps.deleteScoped(claudeConfigDir)
}
