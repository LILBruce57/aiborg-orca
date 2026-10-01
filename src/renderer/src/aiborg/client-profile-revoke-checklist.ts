import { translate } from '@/i18n/i18n'
import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'

export type RevokeChecklistItem = {
  id: string
  label: string
  url: string | null
}

/** What to revoke at the client after a local wipe; AI-Borg cannot revoke remote credentials itself. */
export function buildRevokeChecklist(profile: ClientProfile | null): RevokeChecklistItem[] {
  const host = profile?.github.host ?? 'github.com'
  const items: RevokeChecklistItem[] = [
    {
      id: 'github-pat',
      label: translate('aiborg.clientProfile.revoke.githubPat', 'GitHub personal access token'),
      url: `https://${host}/settings/personal-access-tokens`
    },
    {
      id: 'github-ssh',
      label: translate('aiborg.clientProfile.revoke.githubSsh', 'SSH key on GitHub'),
      url: `https://${host}/settings/keys`
    },
    {
      id: 'claude',
      label: translate('aiborg.clientProfile.revoke.claude', 'Claude session'),
      url: null
    },
    {
      id: 'codex',
      label: translate('aiborg.clientProfile.revoke.codex', 'OpenAI / Codex session'),
      url: null
    }
  ]
  if (profile?.aws || profile?.secrets?.AWS_ACCESS_KEY_ID) {
    items.push({
      id: 'aws',
      label: translate(
        'aiborg.clientProfile.revoke.aws',
        'AWS access keys or SSO session (its token cache in ~/.aws/sso is not removed by AI-Borg)'
      ),
      url: null
    })
  }
  if (profile?.azure) {
    items.push({
      id: 'azure',
      label: translate('aiborg.clientProfile.revoke.azure', 'Azure login'),
      url: null
    })
  }
  if (profile?.gcloud) {
    items.push({
      id: 'gcloud',
      label: translate('aiborg.clientProfile.revoke.gcloud', 'Google Cloud credentials'),
      url: null
    })
  }
  if (!profile || profile.secrets?.SUPABASE_ACCESS_TOKEN) {
    items.push({
      id: 'supabase',
      label: translate('aiborg.clientProfile.revoke.supabase', 'Supabase access token'),
      url: 'https://supabase.com/dashboard/account/tokens'
    })
  }
  items.push({
    id: 'bitwarden',
    label: translate('aiborg.clientProfile.revoke.bitwarden', 'Bitwarden items for this client'),
    url: null
  })
  return items
}
