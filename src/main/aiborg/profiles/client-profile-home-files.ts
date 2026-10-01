import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ClientProfile,
  ClientProfileLoginStatus
} from '../../../shared/aiborg/client-profile-types'
import { clientProfileSshKeyPath } from './client-profile-git-templates'
import type { ClientProfileHomeLayout } from './client-profile-paths'

const PUBLIC_KEY_RE =
  /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]*)?$/

/** Wizard step 2a: the public half of a key held in the Bitwarden SSH agent. */
export async function writeClientProfileSshPublicKey(
  profile: Pick<ClientProfile, 'git'>,
  layout: ClientProfileHomeLayout,
  publicKey: string
): Promise<void> {
  const line = publicKey.trim()
  // Why strict: a pasted private key must never land on disk through this path.
  if (!PUBLIC_KEY_RE.test(line)) {
    throw new Error('AI-Borg: that is not a single-line OpenSSH public key.')
  }
  const path = clientProfileSshKeyPath(profile, layout)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${line}\n`, 'utf8')
}

export async function readClientProfileSshPublicKey(
  profile: Pick<ClientProfile, 'git'>,
  layout: ClientProfileHomeLayout
): Promise<string | null> {
  try {
    return (await readFile(clientProfileSshKeyPath(profile, layout), 'utf8')).trim() || null
  } catch {
    return null
  }
}

/** Wizard step 2b: delete the generated private key once it is imported into Bitwarden. */
export async function removeClientProfileSshPrivateKey(
  profile: Pick<ClientProfile, 'git'>,
  layout: ClientProfileHomeLayout
): Promise<void> {
  const publicPath = clientProfileSshKeyPath(profile, layout)
  if (!publicPath.endsWith('.pub')) {
    throw new Error('AI-Borg: the configured public key path does not end in .pub')
  }
  await rm(publicPath.slice(0, -'.pub'.length), { force: true })
}

/** Login caches the tools own inside P; presence only, contents are never read. */
export function readClientProfileLoginStatus(
  layout: ClientProfileHomeLayout,
  platform: NodeJS.Platform = process.platform
): ClientProfileLoginStatus {
  const any = (dir: string, names: string[]): boolean =>
    names.some((name) => existsSync(join(dir, name)))
  return {
    // macOS keeps Claude's credential in a Keychain item derived from the dir, not a file.
    claude: any(
      layout.claude,
      platform === 'darwin' ? ['.credentials.json', '.claude.json'] : ['.credentials.json']
    ),
    codex: any(layout.codex, ['auth.json']),
    gh: any(layout.gh, ['hosts.yml']),
    az: any(layout.azure, ['msal_token_cache.json', 'msal_token_cache.bin', 'accessTokens.json']),
    gcloud: any(layout.gcloud, ['credentials.db', 'access_tokens.db'])
  }
}
