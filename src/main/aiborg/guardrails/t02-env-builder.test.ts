// T2 (design §3.1-§3.2, §3.4 git floor, §7). Needs the Phase 2 implementation.
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACME,
  ACME_COLOR,
  CONTOSO,
  FIXTURE_SECRETS,
  acmeProfileJson,
  comparablePath,
  contosoProfileJson
} from './client-profile-test-fixtures'
import {
  createClientProfileSandbox,
  type ClientProfileSandbox
} from './client-profile-sandbox-test-fixture'
import {
  clientProfiles,
  type ClientProfile,
  type EnvBuildContext
} from './client-profile-test-harness'
import { rendererSpawn, headlessSpawn } from './client-profile-spawn-test-harness'
import { getClientProfileRuntime } from '../profiles/client-profile-runtime'
import { withClientProfileGitEnv } from '../binding/client-profile-process-env'
import {
  createClientProfileWorld,
  type ClientProfileWorld
} from './client-profile-world-test-harness'

vi.mock(
  'electron',
  async () => (await import('./client-profile-electron-test-fixture')).electronModule
)
vi.mock(
  '@napi-rs/keyring',
  async () => (await import('./client-profile-keyring-test-fixture')).keyringModule
)

const MANAGED_UNSET_FOR_ACME = [
  'GITHUB_TOKEN',
  'GH_HOST',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'AWS_DEFAULT_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_DEFAULT_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS'
]

describe('T2 env builder (pure)', () => {
  let sandbox: ClientProfileSandbox
  let acme: ClientProfile
  let contoso: ClientProfile
  let P: string
  let context: EnvBuildContext

  beforeEach(() => {
    sandbox = createClientProfileSandbox()
    acme = clientProfiles.profileFrom(acmeProfileJson())
    contoso = clientProfiles.profileFrom(contosoProfileJson())
    P = sandbox.profileHome(ACME)
    context = {
      platform: process.platform,
      allProfiles: [acme, contoso],
      basePath: ['base-bin-one', 'base-bin-two'].join(delimiter),
      machine: {
        sshAuthSock: null,
        windowsSsh: 'C:/Windows/System32/OpenSSH/ssh.exe'
      }
    }
  })

  afterEach(() => sandbox.dispose())

  const build = (secrets: Record<string, string> = FIXTURE_SECRETS.acme, profile = acme) =>
    clientProfiles.buildEnv(profile, { ...secrets }, { kind: 'local' }, context)

  it('sets every variable of §3.1 for a local target', () => {
    const { set } = build()
    const path = (...parts: string[]) => comparablePath(join(P, ...parts))
    expect(set).toMatchObject({
      AIBORG_PROFILE_ID: ACME,
      AIBORG_PROFILE_NAME: 'Acme',
      AIBORG_PROFILE_COLOR: ACME_COLOR,
      AIBORG_ALLOWED_ORGS: 'acme-inc acme-labs',
      GH_TOKEN: FIXTURE_SECRETS.acme.GH_TOKEN,
      AWS_PROFILE: 'acme-dev',
      AWS_REGION: 'eu-west-1',
      CLOUDSDK_CORE_PROJECT: 'acme-prod-123',
      SUPABASE_ACCESS_TOKEN: FIXTURE_SECRETS.acme.SUPABASE_ACCESS_TOKEN,
      ACME_SERVICE_TOKEN: FIXTURE_SECRETS.acme.ACME_SERVICE_TOKEN,
      ACME_STAGE: 'acme-stage-dev'
    })
    expect(comparablePath(set.GIT_CONFIG_GLOBAL)).toBe(path('gitconfig'))
    expect(comparablePath(set.GH_CONFIG_DIR)).toBe(path('gh'))
    expect(comparablePath(set.CLAUDE_CONFIG_DIR)).toBe(path('claude'))
    expect(comparablePath(set.CODEX_HOME)).toBe(path('codex'))
    expect(comparablePath(set.AWS_CONFIG_FILE)).toBe(path('aws', 'config'))
    expect(comparablePath(set.AWS_SHARED_CREDENTIALS_FILE)).toBe(path('aws', 'credentials'))
    expect(comparablePath(set.AZURE_CONFIG_DIR)).toBe(path('azure'))
    expect(comparablePath(set.CLOUDSDK_CONFIG)).toBe(path('gcloud'))
    const pathEntries = set.PATH.split(delimiter)
    expect(comparablePath(pathEntries[0])).toBe(path('bin'))
    expect(pathEntries.slice(1)).toEqual(['base-bin-one', 'base-bin-two'])
  })

  it('pins ORCA_CODEX_HOME to CODEX_HOME and spells CLAUDE_CONFIG_DIR identically every time', () => {
    const first = build().set
    const second = build().set
    expect(first.ORCA_CODEX_HOME).toBe(first.CODEX_HOME)
    // The macOS Keychain item is derived from this exact string (§3.1).
    expect(second.CLAUDE_CONFIG_DIR).toBe(first.CLAUDE_CONFIG_DIR)
  })

  it('selects the profile key from the agent with IdentitiesOnly and BatchMode', () => {
    const command = build().set.GIT_SSH_COMMAND
    expect(command).toContain('-o IdentitiesOnly=yes')
    expect(command).toContain('-o BatchMode=yes')
    expect(comparablePath(command)).toContain(
      `-i "${comparablePath(join(P, 'ssh', 'id_ed25519.pub'))}"`
    )
  })

  it('uses the System32 OpenSSH on Windows and plain ssh on macOS', () => {
    const win = clientProfiles.buildEnv(
      acme,
      { ...FIXTURE_SECRETS.acme },
      { kind: 'local' },
      {
        ...context,
        platform: 'win32'
      }
    ).set.GIT_SSH_COMMAND
    expect(win.startsWith('"C:/Windows/System32/OpenSSH/ssh.exe" ')).toBe(true)
    const mac = clientProfiles.buildEnv(
      acme,
      { ...FIXTURE_SECRETS.acme },
      { kind: 'local' },
      {
        ...context,
        platform: 'darwin',
        machine: { sshAuthSock: '/fixture/bitwarden-agent.sock' }
      }
    ).set
    expect(mac.GIT_SSH_COMMAND.startsWith('ssh ')).toBe(true)
    expect(mac.SSH_AUTH_SOCK).toBe('/fixture/bitwarden-agent.sock')
  })

  it('deletes every managed key it does not set, including other profiles’ keys', () => {
    const built = build()
    expect(built.delete).toEqual(expect.arrayContaining(MANAGED_UNSET_FOR_ACME))
    expect(built.delete).toEqual(
      expect.arrayContaining(['CONTOSO_STAGE', 'CONTOSO_REGION_HINT', 'CONTOSO_DEPLOY_TOKEN'])
    )
  })

  it('never deletes a key it sets', () => {
    const built = build()
    const setKeys = new Set(Object.keys(built.set).map((key) => key.toUpperCase()))
    expect(built.delete.filter((key) => setKeys.has(key.toUpperCase()))).toEqual([])
  })

  it('deletes, never inherits, a secret that is missing from the keychain', () => {
    const { GH_TOKEN, ACME_SERVICE_TOKEN } = FIXTURE_SECRETS.acme
    const built = build({ GH_TOKEN, ACME_SERVICE_TOKEN })
    expect(built.set.SUPABASE_ACCESS_TOKEN).toBeUndefined()
    expect(built.delete).toContain('SUPABASE_ACCESS_TOKEN')
  })

  it('sets static AWS keys only when the profile lists them as secrets', () => {
    const withKeys = clientProfiles.profileFrom(
      acmeProfileJson({
        secrets: {
          GH_TOKEN: { bitwarden: 'acme / GitHub' },
          AWS_ACCESS_KEY_ID: { bitwarden: 'acme / AWS id' },
          AWS_SECRET_ACCESS_KEY: { bitwarden: 'acme / AWS secret' }
        }
      })
    )
    const built = build(
      {
        GH_TOKEN: FIXTURE_SECRETS.acme.GH_TOKEN,
        AWS_ACCESS_KEY_ID: 'fixture-acme-aws-id',
        AWS_SECRET_ACCESS_KEY: 'fixture-acme-aws-secret'
      },
      withKeys
    )
    expect(built.set).toMatchObject({
      AWS_ACCESS_KEY_ID: 'fixture-acme-aws-id',
      AWS_SECRET_ACCESS_KEY: 'fixture-acme-aws-secret'
    })
    expect(built.delete).toContain('AWS_SESSION_TOKEN')
    expect(build().set.AWS_ACCESS_KEY_ID).toBeUndefined()
  })

  it('gives contoso none of acme’s values', () => {
    const contosoSet = clientProfiles.buildEnv(
      contoso,
      { ...FIXTURE_SECRETS.contoso },
      { kind: 'local' },
      context
    ).set
    const serialized = JSON.stringify(contosoSet)
    for (const value of [
      ...Object.values(FIXTURE_SECRETS.acme),
      'acme-inc',
      'acme-dev',
      'dev@acme.example'
    ]) {
      expect(serialized).not.toContain(value)
    }
    expect(comparablePath(contosoSet.CLAUDE_CONFIG_DIR)).toBe(
      comparablePath(join(sandbox.profileHome(CONTOSO), 'claude'))
    )
  })

  it('fails closed below git 2.32 (GIT_CONFIG_GLOBAL)', () => {
    expect(clientProfiles.gitVersionSupported('2.31.9')).toBe(false)
    expect(clientProfiles.gitVersionSupported('2.25.1')).toBe(false)
    expect(clientProfiles.gitVersionSupported('2.32.0')).toBe(true)
    expect(clientProfiles.gitVersionSupported('2.53.0.windows.2')).toBe(true)
  })
})

describe('T2 env wrapper (applyClientProfileEnv)', () => {
  let world: ClientProfileWorld

  afterEach(async () => world.dispose())

  it('personal mode changes nothing: same env and envToDelete as stock', async () => {
    const base = { KEEP: '1', GH_TOKEN: 'ambient-personal-gh-token' }
    const worktreeId = 'repo-unbound::/fixture/unbound-app'
    // Stock: before any client-profile state exists.
    const stock = [
      await rendererSpawn({ worktreeId, env: base }),
      await headlessSpawn({ worktreeId, env: base })
    ]
    world = await createClientProfileWorld({ active: null })
    const personal = [
      await rendererSpawn({ worktreeId, env: base }),
      await headlessSpawn({ worktreeId, env: base })
    ]
    for (const [index, result] of personal.entries()) {
      expect(result.env).toEqual(stock[index].env)
      expect(result.envToDelete).toEqual(stock[index].envToDelete)
      expect(result.env.GH_TOKEN).toBe('ambient-personal-gh-token')
    }
    // An unbound worktree and a floating terminal stay stock too.
    const floating = await rendererSpawn({ env: base })
    expect(floating.env.AIBORG_PROFILE_ID).toBeUndefined()
    expect(floating.envToDelete).not.toContain('GITHUB_TOKEN')
  })

  it('profiles folder unset: stale bindings leave Orca git and terminals stock', async () => {
    world = await createClientProfileWorld({ active: ACME })
    const sessionId = `${world.worktreeIds.acme}@@3f4e5d6c`
    await rendererSpawn({ worktreeId: world.worktreeIds.acme, sessionId, env: {} })
    const rt = getClientProfileRuntime()
    expect(rt?.sidecar.read().ptyBindings[sessionId]).toBe(ACME)
    vi.stubEnv('AIBORG_PROFILES_DIR', undefined)
    rt?.sidecar.setProfilesDir(null)
    rt?.store.reload()
    // repoBindings, ptyBindings and activeProfileId are all still in the sidecar.
    expect(rt?.sidecar.read().repoBindings[world.repos.acme.id]).toBe(ACME)
    const input = { KEEP: '1', GH_TOKEN: 'ambient-personal-gh-token' }
    expect(withClientProfileGitEnv(input, { cwd: world.repos.acme.path })).toBe(input)
    const restored = await rendererSpawn({
      worktreeId: world.worktreeIds.acme,
      sessionId,
      env: input
    })
    expect(restored.env.AIBORG_PROFILE_ID).toBeUndefined()
    expect(restored.env.GH_TOKEN).toBe('ambient-personal-gh-token')
  })

  it('appends its git config after caller entries and never overwrites them', async () => {
    world = await createClientProfileWorld({ active: ACME })
    const P = world.profileHome(ACME)
    const { env } = await rendererSpawn({
      worktreeId: world.worktreeIds.acme,
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'caller.key',
        GIT_CONFIG_VALUE_0: 'kept'
      }
    })
    expect(env.GIT_CONFIG_KEY_0).toBe('caller.key')
    expect(env.GIT_CONFIG_VALUE_0).toBe('kept')
    const count = Number(env.GIT_CONFIG_COUNT)
    const entries = Array.from({ length: count }, (_, i) => [
      env[`GIT_CONFIG_KEY_${i}`],
      env[`GIT_CONFIG_VALUE_${i}`]
    ])
    const valueOf = (key: string) => entries.filter(([k]) => k === key).map(([, v]) => v)
    expect(valueOf('core.hooksPath').map(comparablePath)).toEqual([
      comparablePath(join(P, 'hooks'))
    ])
    expect(valueOf('user.name')).toEqual(['Example Acme Dev'])
    expect(valueOf('user.email')).toEqual(['dev@acme.example'])
    expect(valueOf('url.aiborg-blocked://.pushInsteadOf')).toEqual(
      expect.arrayContaining(['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'])
    )
    for (const org of ['acme-inc', 'acme-labs']) {
      expect(valueOf(`url.https://github.com/${org}/.pushInsteadOf`)).toEqual([
        `https://github.com/${org}/`
      ])
      expect(valueOf(`url.git@github.com:${org}/.pushInsteadOf`)).toEqual([
        `git@github.com:${org}/`
      ])
      expect(valueOf(`url.ssh://git@github.com/${org}/.pushInsteadOf`)).toEqual([
        `ssh://git@github.com/${org}/`
      ])
    }
  })

  it.each([
    [
      'a count with missing pairs',
      {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'a.b',
        GIT_CONFIG_VALUE_0: 'c'
      }
    ],
    ['a non-numeric count', { GIT_CONFIG_COUNT: 'two' }],
    ['dangling indexed keys', { GIT_CONFIG_KEY_3: 'a.b', GIT_CONFIG_VALUE_3: 'c' }]
  ])(
    'refuses a profile spawn when the incoming GIT_CONFIG protocol is invalid (%s)',
    async (_label, env) => {
      world = await createClientProfileWorld({ active: ACME })
      await expect(rendererSpawn({ worktreeId: world.worktreeIds.acme, env })).rejects.toThrow()
      await expect(headlessSpawn({ worktreeId: world.worktreeIds.acme, env })).rejects.toThrow()
    }
  )
})

describe('T2 configurable locations (AIBORG_PROFILES_ROOT, AIBORG_PROFILES_DIR)', () => {
  let sandbox: ClientProfileSandbox

  afterEach(() => sandbox.dispose())

  const claudeDirFor = (profile: ClientProfile) =>
    clientProfiles.buildEnv(
      profile,
      { ...FIXTURE_SECRETS.acme },
      { kind: 'local' },
      {
        platform: process.platform,
        allProfiles: [profile],
        basePath: '/usr/bin'
      }
    ).set.CLAUDE_CONFIG_DIR

  it('defaults the profiles root to ~/.aiborg/profiles and honours the override', () => {
    sandbox = createClientProfileSandbox()
    const acme = clientProfiles.profileFrom(acmeProfileJson())
    vi.stubEnv('AIBORG_PROFILES_ROOT', undefined)
    expect(comparablePath(claudeDirFor(acme))).toBe(
      comparablePath(join(sandbox.home, '.aiborg', 'profiles', ACME, 'claude'))
    )
    const elsewhere = join(sandbox.root, 'elsewhere-profiles')
    vi.stubEnv('AIBORG_PROFILES_ROOT', elsewhere)
    expect(comparablePath(claudeDirFor(acme))).toBe(comparablePath(join(elsewhere, ACME, 'claude')))
  })
})

describe('T2 profiles directory override', () => {
  let world: ClientProfileWorld

  afterEach(async () => world.dispose())

  it('loads profiles from AIBORG_PROFILES_DIR even when the sidecar names another directory', async () => {
    world = await createClientProfileWorld({ active: null })
    world.sandbox.writeSidecar({
      ...world.sandbox.readSidecar(),
      profilesDir: join(world.sandbox.root, 'not-the-profiles-dir')
    })
    await clientProfiles.init()
    await clientProfiles.activate(ACME)
    const { env } = await headlessSpawn({
      worktreeId: world.worktreeIds.acme,
      env: {}
    })
    expect(env.AIBORG_PROFILE_ID).toBe(ACME)
  })
})
