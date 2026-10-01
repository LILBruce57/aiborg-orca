import { translate } from '@/i18n/i18n'
import type { ClientProfileLoginTool } from '../../../shared/aiborg/client-profile-types'
import type { ClientProfileSetupTool } from './new-client-profile-form'

export function clientProfileToolLabel(
  tool: ClientProfileSetupTool | ClientProfileLoginTool
): string {
  switch (tool) {
    case 'gh':
      return translate('aiborg.clientProfile.tool.gh', 'GitHub CLI')
    case 'claude':
      return translate('aiborg.clientProfile.tool.claude', 'Claude Code')
    case 'codex':
      return translate('aiborg.clientProfile.tool.codex', 'Codex')
    case 'aws':
      return translate('aiborg.clientProfile.tool.aws', 'AWS')
    case 'az':
    case 'azure':
      return translate('aiborg.clientProfile.tool.azure', 'Azure CLI')
    case 'gcloud':
      return translate('aiborg.clientProfile.tool.gcloud', 'Google Cloud CLI')
    case 'supabase':
      return translate('aiborg.clientProfile.tool.supabase', 'Supabase')
  }
}
