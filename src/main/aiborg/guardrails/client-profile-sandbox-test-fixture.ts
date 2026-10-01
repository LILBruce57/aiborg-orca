// Temp HOME, userData, profiles root and profiles directory for one guardrail test.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { setAppEnvironment, type AppEnvironment } from '../../../shared/app-environment'
import {
  AMBIENT_PERSONAL_ENV,
  acmeProfileJson,
  contosoProfileJson,
  isRecord,
  type ProfileJson
} from './client-profile-test-fixtures'

export type ClientProfileSandbox = {
  root: string
  home: string
  userData: string
  /** `AIBORG_PROFILES_ROOT`: holds `<id>/` tool homes (P in the design). */
  profilesRoot: string
  /** `AIBORG_PROFILES_DIR`: the private `clients/` folder with `<id>.json`. */
  profilesDir: string
  gitSystemConfig: string
  profileHome: (id: string) => string
  sidecarPath: () => string
  writeProfile: (json: ProfileJson, fileName?: string) => void
  writeSidecar: (sidecar: Record<string, unknown>) => void
  readSidecar: () => Record<string, unknown>
  dispose: () => Promise<void>
}

export type SandboxOptions = {
  /** Put AMBIENT_PERSONAL_ENV into main's env (default true). */
  ambient?: boolean
  /** Write acme.json and contoso.json into the profiles directory (default true). */
  profiles?: boolean
}

const GIT_ENV_TO_CLEAR = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_SSH',
  'GIT_SSH_VARIANT',
  'SSH_AUTH_SOCK',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'ORCA_CODEX_HOME',
  'GH_CONFIG_DIR',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_REGION',
  'AZURE_CONFIG_DIR',
  'CLOUDSDK_CONFIG',
  'CLOUDSDK_CORE_PROJECT',
  'AIBORG_UPSTREAM_BEHAVIOR_IN_TESTS'
]

/**
 * Temp HOME/USERPROFILE/APPDATA/LOCALAPPDATA, temp userData, temp profiles root and directory.
 * Nothing a test does may reach the real ~/.claude, ~/.codex, ~/.config/gh, ~/.ssh or cloud config.
 */
export function createClientProfileSandbox(options: SandboxOptions = {}): ClientProfileSandbox {
  // Why realpath: macOS tmpdir is a symlink and git reports resolved paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aiborg-guardrail-')))
  const home = join(root, 'home')
  const userData = join(root, 'userData')
  const profilesRoot = join(home, '.aiborg', 'profiles')
  const profilesDir = join(root, 'private-profiles', 'clients')
  const gitSystemConfig = join(root, 'git', 'system.gitconfig')
  for (const dir of [home, userData, profilesRoot, profilesDir, join(root, 'git')]) {
    mkdirSync(dir, { recursive: true })
  }
  // Why: detached auto-maintenance can outlive a test and lock the temp dir on Windows.
  writeFileSync(gitSystemConfig, '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n')

  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('APPDATA', join(home, 'AppData', 'Roaming'))
  vi.stubEnv('LOCALAPPDATA', join(home, 'AppData', 'Local'))
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'))
  vi.stubEnv('AIBORG_PROFILES_ROOT', profilesRoot)
  vi.stubEnv('AIBORG_PROFILES_DIR', profilesDir)
  // Why: a hermetic system scope; the real one may carry a credential manager (T5 swaps in a fake).
  vi.stubEnv('GIT_CONFIG_SYSTEM', gitSystemConfig)
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0')
  vi.stubEnv('GCM_INTERACTIVE', 'never')
  for (const key of GIT_ENV_TO_CLEAR) {
    vi.stubEnv(key, undefined)
  }
  for (const key of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) {
      vi.stubEnv(key, undefined)
    }
  }
  if (options.ambient ?? true) {
    for (const [key, value] of Object.entries(AMBIENT_PERSONAL_ENV)) {
      vi.stubEnv(key, value)
    }
  } else {
    for (const key of Object.keys(AMBIENT_PERSONAL_ENV)) {
      vi.stubEnv(key, undefined)
    }
  }

  setAppEnvironment(sandboxAppEnvironment(root, home, userData))

  const sandbox: ClientProfileSandbox = {
    root,
    home,
    userData,
    profilesRoot,
    profilesDir,
    gitSystemConfig,
    profileHome: (id) => join(profilesRoot, id),
    sidecarPath: () => join(userData, 'aiborg-client-profiles.json'),
    writeProfile: (json, fileName) => {
      const name = fileName ?? `${String(json.id)}.json`
      writeFileSync(join(profilesDir, name), `${JSON.stringify(json, null, 2)}\n`)
    },
    writeSidecar: (sidecar) => {
      writeFileSync(sandbox.sidecarPath(), `${JSON.stringify(sidecar, null, 2)}\n`)
    },
    readSidecar: () => {
      const parsed: unknown = JSON.parse(readFileSync(sandbox.sidecarPath(), 'utf8'))
      return isRecord(parsed) ? parsed : {}
    },
    dispose: async () => {
      vi.unstubAllEnvs()
      // Why async: on Windows a just-used temp repo can stay locked until the loop turns, and
      // rmSync's retries sleep without letting it.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
  if (options.profiles ?? true) {
    sandbox.writeProfile(acmeProfileJson())
    sandbox.writeProfile(contosoProfileJson())
  }
  return sandbox
}

function sandboxAppEnvironment(root: string, home: string, userData: string): AppEnvironment {
  const paths = {
    userData,
    home,
    appData: join(home, 'AppData', 'Roaming'),
    temp: join(root, 'tmp'),
    downloads: join(home, 'Downloads'),
    logs: join(userData, 'logs'),
    exe: join(root, 'app', 'AI-Borg')
  }
  return {
    getPath: (name) => paths[name],
    getAppPath: () => join(root, 'app'),
    getVersion: () => '0.0.0-guardrail',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  }
}
