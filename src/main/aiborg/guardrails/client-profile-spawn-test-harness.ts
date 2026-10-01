// Drives the real upstream spawn builders (where H20/H21 sit) and the provider env merges.
import { createDaemonPtyEnvironment } from '../../daemon/pty-subprocess/spawn-environment'
import { buildPtyIpcSpawnOptions } from '../../ipc/pty/ipc/spawn-options'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { PtySpawnIpcDeps } from '../../ipc/pty/ipc/spawn-types'
import type { PtyRuntimeControllerDeps } from '../../ipc/pty/runtime/controller-deps'
import { buildRuntimePtySpawnOptions } from '../../ipc/pty/runtime/spawn-options'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import {
  buildLocalPtySpawnEnvironment,
  enforceLocalPtySpawnEnvironmentOverrides
} from '../../providers/local-pty-spawn-environment'
import type { LocalPtyLaunchPlan } from '../../providers/local-pty-launch-plan'
import type { IPtyProvider, PtySpawnOptions } from '../../providers/types'

export type SpawnRequest = {
  worktreeId?: string
  env?: Record<string, string>
  connectionId?: string | null
  /** True: the daemon host path; false: the LocalPtyProvider fallback (local only). */
  daemon?: boolean
  wslDistro?: string | null
  sessionId?: string
  /** Renderer only: a terminal Codex resume pinned to this home (H48). */
  codexResumeHome?: string
  /** Session ids the provider reports alive (a daemon reattach); default: none. */
  liveSessionIds?: readonly string[]
}

function providerWithLiveSessions(ids: readonly string[]): IPtyProvider {
  const live = new Set(ids)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: H20/H21 read only probePtyLiveness before the provider spawns, and these harnesses never spawn.
  return { probePtyLiveness: async (id: string) => live.has(id) } as unknown as IPtyProvider
}

export type SpawnResult = {
  env: Record<string, string>
  envToDelete: string[]
  codexHomePathOverride: { value: string | null } | undefined
  spawnOptions: PtySpawnOptions
  /** The builder's own env object after the build (`ctx.spawnEnv` / `ctx.env`). */
  ctxEnv: Record<string, string>
}

/** Renderer path: `pty:spawn` → buildPtyIpcSpawnOptions (H20). */
export async function rendererSpawn(request: SpawnRequest): Promise<SpawnResult> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: with no runtime, launch agent or hidden pane the option builder reads no required dependency.
  const ctx = createPtyIpcSpawnState({} as PtySpawnIpcDeps, {
    cols: 80,
    rows: 24,
    connectionId: request.connectionId ?? null,
    ...(request.worktreeId !== undefined ? { worktreeId: request.worktreeId } : {}),
    ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {})
  })
  ctx.env = { ...request.env }
  ctx.isDaemonHostSpawn = request.daemon ?? true
  if (request.sessionId !== undefined) {
    ctx.effectiveSessionId = request.sessionId
  }
  if (request.wslDistro) {
    ctx.expectedWslDistro = request.wslDistro
    ctx.codexSelectionTarget = { runtime: 'wsl', wslDistro: request.wslDistro }
  }
  if (request.codexResumeHome !== undefined) {
    ctx.codexResumeHomeSelected = true
    ctx.selectedCodexHomePath = request.codexResumeHome
  }
  if (request.liveSessionIds) {
    ctx.provider = providerWithLiveSessions(request.liveSessionIds)
  }
  try {
    await buildPtyIpcSpawnOptions(ctx)
  } finally {
    ctx.finishTerminalInstall()
  }
  return {
    env: ctx.spawnOptions.env ?? {},
    envToDelete: ctx.spawnOptions.envToDelete ?? [],
    codexHomePathOverride: ctx.spawnOptions.codexHomePathOverride,
    spawnOptions: ctx.spawnOptions,
    ctxEnv: ctx.spawnEnv ?? {}
  }
}

/** Headless path: orca CLI, automations, mobile, runtime agents → buildRuntimePtySpawnOptions (H21). */
export async function headlessSpawn(request: SpawnRequest): Promise<SpawnResult> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: with no store, launch agent or pane identity the option builder reads no required dependency.
  const ctx = createRuntimePtySpawnState({} as PtyRuntimeControllerDeps, {
    cols: 80,
    rows: 24,
    connectionId: request.connectionId ?? null,
    ...(request.worktreeId !== undefined ? { worktreeId: request.worktreeId } : {})
  })
  const env = { ...request.env }
  ctx.env = env
  ctx.isDaemonHostSpawn = request.daemon ?? true
  if (request.sessionId !== undefined) {
    ctx.sessionId = request.sessionId
  }
  if (request.wslDistro) {
    ctx.expectedWslDistro = request.wslDistro
    ctx.codexSelectionTarget = { runtime: 'wsl', wslDistro: request.wslDistro }
  }
  if (request.liveSessionIds) {
    ctx.provider = providerWithLiveSessions(request.liveSessionIds)
  }
  try {
    await buildRuntimePtySpawnOptions(ctx)
  } finally {
    ctx.finishTerminalInstall()
  }
  return {
    env: ctx.spawnOptions.env ?? {},
    envToDelete: ctx.spawnOptions.envToDelete ?? [],
    codexHomePathOverride: ctx.spawnOptions.codexHomePathOverride,
    spawnOptions: ctx.spawnOptions,
    ctxEnv: ctx.env
  }
}

/** What the terminal daemon hands the shell: its own env + spawn env, minus envToDelete. */
export function daemonChildEnv(
  spawn: Pick<SpawnResult, 'env' | 'envToDelete'>
): Record<string, string> {
  return createDaemonPtyEnvironment({
    sessionId: 'guardrail-session',
    cols: 80,
    rows: 24,
    env: spawn.env,
    envToDelete: spawn.envToDelete
  })
}

/** The LocalPtyProvider fallback merge (without the app-level buildSpawnEnv, which T14 covers). */
export async function localProviderChildEnv(spawn: SpawnResult): Promise<Record<string, string>> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: with no buildSpawnEnv option only plan.shellPath is read.
  const plan = {
    shellPath: '/bin/bash',
    cwd: process.cwd()
  } as LocalPtyLaunchPlan
  const env = await buildLocalPtySpawnEnvironment({
    id: 'guardrail-local',
    spawn: spawn.spawnOptions,
    getOptions: () => ({}),
    plan
  })
  enforceLocalPtySpawnEnvironmentOverrides(spawn.spawnOptions, env)
  return env
}

export function worktreeIdFor(repoId: string, worktreePath: string): string {
  return `${repoId}::${worktreePath}`
}

/** The env a daemon terminal in `worktreeId` starts with (headless path: no active-profile check). */
export async function terminalChildEnv(worktreeId: string): Promise<Record<string, string>> {
  return daemonChildEnv(await headlessSpawn({ worktreeId, env: {} }))
}
