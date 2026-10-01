import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { validateClientProfile } from '../../../shared/aiborg/client-profile-schema'

export const CLIENT_PROFILE_SETUP_TOOLS = [
  'gh',
  'claude',
  'codex',
  'aws',
  'azure',
  'gcloud',
  'supabase'
] as const

export type ClientProfileSetupTool = (typeof CLIENT_PROFILE_SETUP_TOOLS)[number]

export type NewClientProfileForm = {
  id: string
  name: string
  color: string
  githubHost: string
  allowedOrgs: string
  gitUserName: string
  gitUserEmail: string
  tools: Record<ClientProfileSetupTool, boolean>
  awsProfile: string
  awsRegion: string
  gcloudProject: string
  /** Optional Bitwarden item names; the wizard can then import with `bw get password`. */
  ghTokenBitwarden: string
  supabaseBitwarden: string
}

export const GH_TOKEN_SECRET = 'GH_TOKEN'
export const SUPABASE_TOKEN_SECRET = 'SUPABASE_ACCESS_TOKEN'

export function createEmptyClientProfileForm(): NewClientProfileForm {
  return {
    id: '',
    name: '',
    color: '#2f80ed',
    githubHost: 'github.com',
    allowedOrgs: '',
    gitUserName: '',
    gitUserEmail: '',
    tools: {
      gh: true,
      claude: true,
      codex: true,
      aws: false,
      azure: false,
      gcloud: false,
      supabase: false
    },
    awsProfile: '',
    awsRegion: '',
    gcloudProject: '',
    ghTokenBitwarden: '',
    supabaseBitwarden: ''
  }
}

export function parseAllowedOrgs(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((org) => org.trim().toLowerCase())
        .filter(Boolean)
    )
  ]
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function secretRef(bitwardenItem: string): { bitwarden?: string } {
  const item = optionalText(bitwardenItem)
  return item ? { bitwarden: item } : {}
}

export function buildClientProfileFromForm(form: NewClientProfileForm): ClientProfile {
  const secrets: Record<string, { bitwarden?: string }> = {}
  if (form.tools.gh) {
    secrets[GH_TOKEN_SECRET] = secretRef(form.ghTokenBitwarden)
  }
  if (form.tools.supabase) {
    secrets[SUPABASE_TOKEN_SECRET] = secretRef(form.supabaseBitwarden)
  }
  const awsProfile = optionalText(form.awsProfile)
  const awsRegion = optionalText(form.awsRegion)
  const gcloudProject = optionalText(form.gcloudProject)
  return {
    schemaVersion: 1,
    id: form.id.trim(),
    name: form.name.trim(),
    color: form.color.toLowerCase(),
    github: {
      host: form.githubHost.trim().toLowerCase() || 'github.com',
      allowedOrgs: parseAllowedOrgs(form.allowedOrgs)
    },
    git: {
      userName: form.gitUserName.trim(),
      userEmail: form.gitUserEmail.trim()
    },
    ...(form.tools.aws
      ? {
          aws: {
            ...(awsProfile ? { profile: awsProfile } : {}),
            ...(awsRegion ? { region: awsRegion } : {})
          }
        }
      : {}),
    ...(form.tools.azure ? { azure: {} } : {}),
    ...(form.tools.gcloud ? { gcloud: gcloudProject ? { project: gcloudProject } : {} } : {}),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {})
  }
}

/** Errors for the identity step; empty when the profile can be saved. */
export function validateNewClientProfileForm(
  form: NewClientProfileForm,
  existingIds: readonly string[]
): string[] {
  const profile = buildClientProfileFromForm(form)
  const result = validateClientProfile(profile, profile.id)
  const errors = result.ok ? [] : [...result.errors]
  if (existingIds.includes(profile.id)) {
    errors.unshift(`id "${profile.id}" is already used`)
  }
  if (form.tools.aws && !profile.aws?.profile) {
    errors.push('aws.profile: name the AWS profile to use')
  }
  return errors
}
