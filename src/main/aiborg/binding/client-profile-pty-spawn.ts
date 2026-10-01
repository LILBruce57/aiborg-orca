import { isWslUncPath } from '../../../shared/wsl-paths'
import type { IPtyProvider } from '../../providers/types'
import type { PtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { RuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import {
  auditClientProfile,
  getActiveClientProfileId,
  getClientProfilePtyBinding,
  hasClientProfilesConfigured,
  setClientProfilePtyBinding
} from './client-profile-core-access'
import type { ClientProfileSpawnTarget } from '../../../shared/aiborg/client-profile-types'
import {
  applyClientProfileEnvApplication,
  buildClientProfileEnvApplication,
  type ClientProfileEnvApplication
} from './client-profile-process-env'
import { ClientProfileRefusalError } from './client-profile-refusal'
import {
  resolveClientProfileById,
  resolveWorktreeClientProfile,
  type ClientProfileResolution
} from './client-profile-resolution'
import { accountHomesEqual } from './client-profile-account-home'

type SpawnOrigin = 'renderer' | 'runtime'

type PtySpawnProfileInput = {
  origin: SpawnOrigin
  worktreeId: string | undefined
  connectionId: string | null | undefined
  wslDistro: string | null
  cwd: string | undefined
  /** Session id known before spawn (daemon); its binding wins only for a live session (§4.1). */
  sessionKey: string | undefined
  provider: Pick<IPtyProvider, 'hasPty' | 'probePtyLiveness'> | undefined
  env: NodeJS.ProcessEnv
  /** Codex resume home the launch selected (H48), when one was selected. */
  codexResumeHome: string | null
}

/** Profile each spawn context was built under, committed to `ptyBindings` once the id is known. */
const pendingBindings = new WeakMap<object, string>()

// Why: the launch preflight names the home it was generated for; the profile home differs.
const PROFILE_SPAWN_EXTRA_DELETES = ['ORCA_CODEX_LAUNCH_PREFLIGHT']

function spawnTarget(input: PtySpawnProfileInput): ClientProfileSpawnTarget {
  if (input.connectionId) {
    return { kind: 'ssh', connectionId: input.connectionId }
  }
  return input.wslDistro || (input.cwd && isWslUncPath(input.cwd))
    ? { kind: 'wsl', distro: input.wslDistro }
    : { kind: 'local' }
}

async function isSessionLive(input: PtySpawnProfileInput): Promise<boolean | null> {
  const { provider, sessionKey } = input
  if (!provider || !sessionKey) {
    return false
  }
  try {
    if (provider.probePtyLiveness) {
      return await provider.probePtyLiveness(sessionKey)
    }
    return provider.hasPty ? provider.hasPty(sessionKey) : null
  } catch {
    return null
  }
}

function refuseUnverifiablePin(pinned: string, input: PtySpawnProfileInput): never {
  auditClientProfile(pinned, 'terminal.refused', {
    worktreeId: input.worktreeId ?? null,
    reason: 'pin-unverifiable'
  })
  throw new ClientProfileRefusalError(
    'profile-mismatch',
    pinned,
    `AI-Borg: this terminal was opened under client profile ${pinned}, and AI-Borg cannot confirm it is still running. Close it and open a new terminal.`
  )
}

type SpawnProfile = { resolved: ClientProfileResolution; reattach: boolean }

/**
 * A pinned session that is still alive is a reattach: it keeps its profile (its env is fixed
 * and a reattach sends none). A dead one is a cold restore, re-resolved from the worktree.
 */
async function resolveSpawnProfile(input: PtySpawnProfileInput): Promise<SpawnProfile> {
  const resolved = resolveWorktreeClientProfile(input.worktreeId)
  const pinned = input.sessionKey ? getClientProfilePtyBinding(input.sessionKey) : null
  const matchesActive = input.origin !== 'renderer' || pinned === getActiveClientProfileId()
  if (!pinned || (pinned === resolved.profileId && matchesActive)) {
    return { resolved, reattach: false }
  }
  const live = await isSessionLive(input)
  if (live === true) {
    return {
      resolved: { ...resolved, ...resolveClientProfileById(pinned, 'pty') },
      reattach: true
    }
  }
  if (pinned !== resolved.profileId) {
    if (live === null) {
      refuseUnverifiablePin(pinned, input)
    }
    writeBinding(input.sessionKey ?? '', null)
  }
  return { resolved, reattach: false }
}

function refuseMismatch(resolved: ClientProfileResolution, input: PtySpawnProfileInput): never {
  const activeId = getActiveClientProfileId()
  const name = resolved.profile?.name ?? resolved.profileId
  auditClientProfile(resolved.profileId ?? '', 'terminal.refused', {
    worktreeId: input.worktreeId ?? null,
    reason: 'profile-mismatch',
    activeProfileId: activeId
  })
  throw new ClientProfileRefusalError(
    'profile-mismatch',
    resolved.profileId,
    activeId
      ? `AI-Borg: this workspace belongs to client profile ${name}, but another profile is active. Switch to ${name} to open terminals here.`
      : `AI-Borg: this workspace belongs to client profile ${name}. Switch to ${name} to open terminals here.`
  )
}

async function buildSpawnApplication(
  input: PtySpawnProfileInput
): Promise<ClientProfileEnvApplication | null> {
  if (!hasClientProfilesConfigured()) {
    return null
  }
  const { resolved, reattach } = await resolveSpawnProfile(input)
  if (!resolved.profileId) {
    return null
  }
  // Fresh renderer spawns and cold restores must match the visible profile; reattaches keep theirs.
  if (
    input.origin === 'renderer' &&
    !reattach &&
    resolved.profileId !== getActiveClientProfileId()
  ) {
    refuseMismatch(resolved, input)
  }
  const application = buildClientProfileEnvApplication(resolved, {
    target: spawnTarget(input),
    baseEnv: input.env,
    action: `terminal.${input.origin}`
  })
  if (
    application &&
    input.codexResumeHome &&
    !accountHomesEqual(input.codexResumeHome, application.layout.codex)
  ) {
    auditClientProfile(application.profile.id, 'terminal.refused', {
      worktreeId: input.worktreeId ?? null,
      reason: 'account-home-mismatch'
    })
    throw new ClientProfileRefusalError(
      'account-home-mismatch',
      application.profile.id,
      `AI-Borg: this Codex session was recorded outside client profile ${application.profile.name} and cannot resume under it.`
    )
  }
  return application
}

type SpawnContextLike = object & {
  args: { worktreeId?: string; connectionId?: string | null }
  isDaemonHostSpawn?: boolean
}

// Why audit here: every applied profile env is logged (§4 step 7), even if the spawn then fails.
// Why record before spawn too: daemon session ids are stable, so the border is right from byte 0.
function recordSpawnBinding(
  ctx: SpawnContextLike,
  sessionKey: string | undefined,
  application: ClientProfileEnvApplication
): void {
  pendingBindings.set(ctx, application.profile.id)
  auditClientProfile(application.profile.id, 'terminal.spawn', {
    ptyId: sessionKey ?? null,
    worktreeId: ctx.args.worktreeId ?? null,
    provider: ctx.args.connectionId ? 'ssh' : ctx.isDaemonHostSpawn ? 'daemon' : 'local'
  })
  if (sessionKey) {
    writeBinding(sessionKey, application.profile.id)
  }
}

// Why never throw: a binding drives chrome (the border); a sidecar failure must not fail a spawn
// or abort upstream PTY teardown (H22e).
function writeBinding(ptyId: string, profileId: string | null): void {
  try {
    if (ptyId && getClientProfilePtyBinding(ptyId) !== profileId) {
      setClientProfilePtyBinding(ptyId, profileId)
    }
  } catch (error) {
    console.warn('[aiborg] could not record a terminal profile binding', error)
  }
}

/** H20 (+H48): renderer spawns; runs after the requested deletes, before spawnOptions is built. */
export async function applyClientProfileEnvToRendererSpawn(ctx: PtyIpcSpawnState): Promise<void> {
  const env: Record<string, string> = ctx.spawnEnv ?? {}
  const application = await buildSpawnApplication({
    origin: 'renderer',
    worktreeId: ctx.args.worktreeId,
    connectionId: ctx.args.connectionId,
    wslDistro: ctx.expectedWslDistro,
    cwd: ctx.cwd,
    sessionKey: ctx.effectiveSessionAppId ?? ctx.effectiveSessionId,
    provider: ctx.provider,
    env,
    codexResumeHome: ctx.codexResumeHomeSelected ? ctx.selectedCodexHomePath : null
  })
  if (!application) {
    return
  }
  ctx.combinedEnvToDelete = applyClientProfileEnvApplication(
    env,
    application,
    ctx.combinedEnvToDelete,
    PROFILE_SPAWN_EXTRA_DELETES
  )
  ctx.spawnEnv = env
  if (!ctx.args.connectionId) {
    // Read into codexHomePathOverride, which the LocalPtyProvider fallback re-applies last.
    ctx.selectedCodexHomePath = application.layout.codex
  }
  recordSpawnBinding(ctx, ctx.effectiveSessionAppId ?? ctx.effectiveSessionId, application)
}

/** H21: headless spawns use the repo's profile with no active-profile check (§4.1). */
export async function applyClientProfileEnvToRuntimeSpawn(
  ctx: RuntimePtySpawnState
): Promise<void> {
  const env: Record<string, string> = ctx.env ?? {}
  const application = await buildSpawnApplication({
    origin: 'runtime',
    worktreeId: ctx.args.worktreeId,
    connectionId: ctx.args.connectionId,
    wslDistro: ctx.expectedWslDistro,
    cwd: ctx.cwd,
    sessionKey: ctx.effectiveSessionAppId ?? ctx.sessionId,
    provider: ctx.provider,
    env,
    codexResumeHome: ctx.codexResumeHomeSelected ? ctx.selectedCodexHomePath : null
  })
  if (!application) {
    return
  }
  ctx.spawnOptions.envToDelete = applyClientProfileEnvApplication(
    env,
    application,
    ctx.spawnOptions.envToDelete,
    PROFILE_SPAWN_EXTRA_DELETES
  )
  // Why both: spawnOptions.env aliases ctx.env, and ctx.env may have been undefined.
  ctx.env = env
  ctx.spawnOptions.env = env
  if (!ctx.args.connectionId) {
    ctx.selectedCodexHomePath = application.layout.codex
    if (ctx.spawnOptions.codexHomePathOverride) {
      ctx.spawnOptions.codexHomePathOverride = {
        value: application.layout.codex
      }
    }
  }
  recordSpawnBinding(ctx, ctx.effectiveSessionAppId ?? ctx.sessionId, application)
}

/** Records `ptyId → profile` once the provider returned the id; the pane border reads it. */
export function commitClientProfilePtyBinding(
  ctx: object & { args: { worktreeId?: string } },
  ptyId: string
): void {
  const profileId = pendingBindings.get(ctx)
  pendingBindings.delete(ctx)
  if (profileId && ptyId) {
    writeBinding(ptyId, profileId)
  }
}

/** Drops the binding when the PTY's provider state is torn down. Never throws. */
export function forgetClientProfilePtyBinding(ptyId: string): void {
  writeBinding(ptyId, null)
}
