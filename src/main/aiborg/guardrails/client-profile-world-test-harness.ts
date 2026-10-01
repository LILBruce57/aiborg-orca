// A ready-made acme + contoso world: sandbox, sidecar, bound repos, keychain secrets, active profile.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ACME, CONTOSO, FIXTURE_SECRETS } from './client-profile-test-fixtures'
import {
  createClientProfileSandbox,
  type ClientProfileSandbox,
  type SandboxOptions
} from './client-profile-sandbox-test-fixture'
import { resetKeyring } from './client-profile-keyring-test-fixture'
import { clientProfiles, type KnownRepo } from './client-profile-test-harness'
import { worktreeIdFor } from './client-profile-spawn-test-harness'

export const REPO_ACME = 'repo-acme'
export const REPO_CONTOSO = 'repo-contoso'
export const REPO_UNBOUND = 'repo-unbound'

export type ClientProfileWorld = {
  sandbox: ClientProfileSandbox
  repos: { acme: KnownRepo; contoso: KnownRepo; unbound: KnownRepo }
  worktreeIds: { acme: string; contoso: string; unbound: string }
  /** P in the design: `<profiles root>/<id>`. */
  profileHome: (id: string) => string
  dispose: () => Promise<void>
}

export type WorldOptions = {
  active?: string | null
  sandbox?: SandboxOptions
  /** Store FIXTURE_SECRETS through the keychain module (default true). */
  secrets?: boolean
  machine?: { sshAuthSock?: string | null; windowsSsh?: string | null }
}

export const WINDOWS_OPENSSH = 'C:/Windows/System32/OpenSSH/ssh.exe'

export async function createClientProfileWorld(
  options: WorldOptions = {}
): Promise<ClientProfileWorld> {
  resetKeyring()
  const sandbox = createClientProfileSandbox(options.sandbox)
  let repos: ClientProfileWorld['repos']
  try {
    const repoPath = (name: string): string => {
      const path = join(sandbox.root, 'work', name)
      mkdirSync(path, { recursive: true })
      return path
    }
    repos = {
      acme: { id: REPO_ACME, path: repoPath('acme-app') },
      contoso: { id: REPO_CONTOSO, path: repoPath('contoso-app') },
      unbound: { id: REPO_UNBOUND, path: repoPath('unbound-app') }
    }
    // The sidecar format is specified in design §1.1.
    sandbox.writeSidecar({
      version: 1,
      profilesDir: sandbox.profilesDir,
      activeProfileId: null,
      repoBindings: { [REPO_ACME]: ACME, [REPO_CONTOSO]: CONTOSO },
      ptyBindings: {},
      storedSecretNames: {},
      machine: {
        sshAuthSock: null,
        windowsSsh: WINDOWS_OPENSSH,
        ...options.machine
      }
    })
    clientProfiles.registerRepos([repos.acme, repos.contoso, repos.unbound])
    await clientProfiles.init()
    await clientProfiles.bindRepo(REPO_ACME, ACME)
    await clientProfiles.bindRepo(REPO_CONTOSO, CONTOSO)
    if (options.secrets ?? true) {
      for (const profileId of [ACME, CONTOSO] as const) {
        for (const [name, value] of Object.entries(FIXTURE_SECRETS[profileId])) {
          await clientProfiles.keychain.setSecret(profileId, name, value)
        }
      }
    }
    if (options.active) {
      await clientProfiles.activate(options.active)
    }
  } catch (error) {
    // Why: a half-built world must not leak env stubs or temp dirs into the next test.
    await clientProfiles.reset().catch(() => {})
    await sandbox.dispose()
    throw error
  }
  return {
    sandbox,
    repos,
    worktreeIds: {
      acme: worktreeIdFor(REPO_ACME, repos.acme.path),
      contoso: worktreeIdFor(REPO_CONTOSO, repos.contoso.path),
      unbound: worktreeIdFor(REPO_UNBOUND, repos.unbound.path)
    },
    profileHome: sandbox.profileHome,
    dispose: async () => {
      await clientProfiles.reset()
      resetKeyring()
      await sandbox.dispose()
    }
  }
}
