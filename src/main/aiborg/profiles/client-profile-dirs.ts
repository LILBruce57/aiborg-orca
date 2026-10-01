import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ClientProfile,
  ClientProfileMachineSettings
} from '../../../shared/aiborg/client-profile-types'
import {
  CLIENT_PROFILE_TOOL_DIRS,
  clientProfileHomeLayout,
  type ClientProfileHomeLayout
} from './client-profile-paths'
import {
  buildClientProfileGitconfig,
  buildClientProfileSshCommand,
  buildClientProfileSshConfig,
  parseSafeDirectories
} from './client-profile-git-templates'
import {
  BLOCKED_REMOTE_HELPER_NAME,
  CLIENT_PROFILE_CHAIN_STUB,
  CLIENT_PROFILE_CHAINED_HOOK_NAMES,
  buildBlockedRemoteHelper,
  buildHookChainStub,
  buildPassThroughHook,
  buildPrePushHook
} from './client-profile-hook-templates'
import {
  CLIENT_PROFILE_POWERSHELL_PROMPT_FILE,
  getClientProfilePowerShellPromptScript
} from '../env/client-profile-shell-restore'

/** GIT_CONFIG_GLOBAL needs git 2.32 (GIT_CONFIG_COUNT 2.31); older git fails closed. */
export const CLIENT_PROFILE_MIN_GIT_VERSION: readonly [number, number] = [2, 32]

export function parseGitVersion(output: string): [number, number] | null {
  const match = output.trim().match(/^(?:git version\s+)?(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2])] : null
}

export function isGitVersionSupportedForClientProfiles(output: string): boolean {
  const version = parseGitVersion(output)
  const [major, minor] = CLIENT_PROFILE_MIN_GIT_VERSION
  return version !== null && (version[0] > major || (version[0] === major && version[1] >= minor))
}

export type EnsureClientProfileHomeOptions = {
  root: string
  machine: ClientProfileMachineSettings
  platform?: NodeJS.Platform
  /** The user's own env (main's process.env), used for the global gitconfig and SystemRoot. */
  env?: NodeJS.ProcessEnv
  home?: string
}

/** The user's global gitconfig candidates, read only (never written). */
function userGlobalGitconfigPaths(env: NodeJS.ProcessEnv, home: string): string[] {
  if (env.GIT_CONFIG_GLOBAL) {
    return [env.GIT_CONFIG_GLOBAL]
  }
  const xdg = env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, 'git', 'config')
    : join(home, '.config', 'git', 'config')
  return [join(home, '.gitconfig'), xdg]
}

export async function readUserSafeDirectories(
  env: NodeJS.ProcessEnv,
  home: string
): Promise<string[]> {
  const found: string[] = []
  for (const path of userGlobalGitconfigPaths(env, home)) {
    try {
      found.push(...parseSafeDirectories(await readFile(path, 'utf8')))
    } catch {
      // Missing or unreadable global config: nothing to copy.
    }
  }
  return [...new Set(found)]
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  // Why LF only: Git for Windows' sh rejects CRLF shebang lines.
  await writeFile(path, contents.replaceAll('\r\n', '\n'), { encoding: 'utf8', mode: 0o755 })
  await chmod(path, 0o755)
}

/**
 * Creates P/* and (re)writes the generated gitconfig, ssh config, hooks and P/bin helper.
 * Runs on activation and whenever the profile JSON changes.
 */
export async function ensureClientProfileHome(
  profile: ClientProfile,
  options: EnsureClientProfileHomeOptions
): Promise<ClientProfileHomeLayout> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const layout = clientProfileHomeLayout(options.root, profile.id)
  await mkdir(layout.home, { recursive: true })
  await Promise.all(
    CLIENT_PROFILE_TOOL_DIRS.map((dir) => mkdir(join(layout.home, dir), { recursive: true }))
  )
  const sshCommand = buildClientProfileSshCommand({
    profile,
    layout,
    platform,
    machine: options.machine,
    env
  })
  const safeDirectories = await readUserSafeDirectories(env, options.home ?? homedir())
  await writeFile(
    layout.gitconfig,
    buildClientProfileGitconfig({ profile, layout, platform, sshCommand, safeDirectories }),
    'utf8'
  )
  await writeFile(layout.sshConfig, buildClientProfileSshConfig(profile, layout), 'utf8')
  await writeExecutable(join(layout.hooks, 'pre-push'), buildPrePushHook(profile, layout))
  await writeExecutable(
    join(layout.hooks, CLIENT_PROFILE_CHAIN_STUB),
    buildHookChainStub(profile.id, layout)
  )
  await Promise.all(
    CLIENT_PROFILE_CHAINED_HOOK_NAMES.map((name) =>
      writeExecutable(join(layout.hooks, name), buildPassThroughHook(profile.id, name, layout))
    )
  )
  await writeExecutable(
    join(layout.bin, BLOCKED_REMOTE_HELPER_NAME),
    buildBlockedRemoteHelper(profile, layout)
  )
  await writeFile(
    join(layout.bin, CLIENT_PROFILE_POWERSHELL_PROMPT_FILE),
    getClientProfilePowerShellPromptScript(),
    'utf8'
  )
  return layout
}

/** The generated files the push guards and credential reset depend on (fail closed without them). */
export function hasClientProfileGuardFiles(layout: ClientProfileHomeLayout): boolean {
  return (
    existsSync(layout.gitconfig) &&
    existsSync(join(layout.hooks, 'pre-push')) &&
    existsSync(join(layout.bin, BLOCKED_REMOTE_HELPER_NAME))
  )
}

/** Deletes P recursively (delete flow step 4). */
export async function removeClientProfileHome(root: string, profileId: string): Promise<void> {
  await rm(clientProfileHomeLayout(root, profileId).home, { recursive: true, force: true })
}
