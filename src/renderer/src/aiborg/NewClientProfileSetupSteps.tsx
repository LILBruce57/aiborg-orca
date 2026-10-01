import { useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { getClientProfilesApi } from './client-profile-bridge'
import {
  GH_VERIFY_COMMAND,
  loginCommandFor,
  sshKeygenCommand
} from './client-profile-setup-commands'
import { findClientProfileEntry, useClientProfileStore } from './client-profile-store'
import { clientProfileToolLabel } from './client-profile-tool-labels'
import { ClientProfileSecretRow } from './ClientProfileSecretRow'
import { ClientProfileSetupCommandRow } from './ClientProfileSetupCommandRow'
import {
  CLIENT_PROFILE_SETUP_TOOLS,
  GH_TOKEN_SECRET,
  SUPABASE_TOKEN_SECRET,
  type ClientProfileSetupTool
} from './new-client-profile-form'

type StepProps = {
  profile: ClientProfile
  tools: Record<ClientProfileSetupTool, boolean>
  bitwardenUnlocked: boolean
}

function reportError(error: unknown): void {
  toast.error(translate('aiborg.clientProfile.wizard.stepFailed', 'That step failed'), {
    description: error instanceof Error ? error.message : String(error)
  })
}

function privateKeyPath(profilesRoot: string, profileId: string): string {
  const separator = profilesRoot.includes('\\') ? '\\' : '/'
  return [profilesRoot.replace(/[\\/]+$/, ''), profileId, 'ssh', 'id_ed25519'].join(separator)
}

function SecretFor({
  profile,
  name,
  bitwardenUnlocked
}: {
  profile: ClientProfile
  name: string
  bitwardenUnlocked: boolean
}): React.JSX.Element {
  const snapshot = useClientProfileStore((s) => s.snapshot)
  const entry = findClientProfileEntry(snapshot, profile.id)
  return (
    <ClientProfileSecretRow
      profileId={profile.id}
      name={name}
      state={entry?.secretStatus[name] ?? 'missing'}
      bitwardenRef={profile.secrets?.[name]?.bitwarden ?? null}
      bitwardenUnlocked={bitwardenUnlocked}
      readOnly={!(snapshot?.keychainAvailable ?? false)}
    />
  )
}

export function SshKeyStep({ profile }: StepProps): React.JSX.Element {
  const profilesRoot = useClientProfileStore((s) => s.snapshot?.profilesRoot ?? '')
  const [pasted, setPasted] = useState('')
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const api = getClientProfilesApi()
  const host = profile.github.host

  const savePasted = async (): Promise<void> => {
    await api?.writeSshPublicKey({
      profileId: profile.id,
      publicKey: pasted.trim()
    })
    setPublicKey(pasted.trim())
    toast.success(translate('aiborg.clientProfile.wizard.sshSaved', 'Public key saved'))
  }
  const loadGenerated = async (): Promise<void> => {
    const key = (await api?.readSshPublicKey({ profileId: profile.id })) ?? null
    if (!key) {
      toast.message(
        translate(
          'aiborg.clientProfile.wizard.sshNotFound',
          'No public key yet. Finish ssh-keygen first.'
        )
      )
    }
    setPublicKey(key)
  }
  const removePrivate = async (): Promise<void> => {
    await api?.removeSshPrivateKey({ profileId: profile.id })
    toast.success(
      translate('aiborg.clientProfile.wizard.sshPrivateRemoved', 'Private key removed from disk')
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="aiborg-ssh-paste">
          {translate(
            'aiborg.clientProfile.wizard.sshPasteLabel',
            'Public key of a key in your Bitwarden SSH agent'
          )}
        </Label>
        <Textarea
          id="aiborg-ssh-paste"
          rows={2}
          spellCheck={false}
          value={pasted}
          placeholder={translate(
            'aiborg.clientProfile.wizard.sshPastePlaceholder',
            'ssh-ed25519 AAAA… dev@acme.example'
          )}
          onChange={(event) => setPasted(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          disabled={!pasted.trim().startsWith('ssh-')}
          onClick={() => void savePasted().catch(reportError)}
        >
          {translate('aiborg.clientProfile.wizard.sshSave', 'Save public key')}
        </Button>
      </div>
      <ClientProfileSetupCommandRow
        profileId={profile.id}
        label={translate('aiborg.clientProfile.wizard.sshGenerate', 'Or generate a new key')}
        command={sshKeygenCommand(profile.git.userEmail, privateKeyPath(profilesRoot, profile.id))}
        hint={translate(
          'aiborg.clientProfile.wizard.sshGenerateHint',
          'Then import the private key into Bitwarden and remove it from disk below.'
        )}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void loadGenerated().catch(reportError)}
        >
          {translate('aiborg.clientProfile.wizard.sshLoad', 'Show public key')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void removePrivate().catch(reportError)}
        >
          {translate(
            'aiborg.clientProfile.wizard.sshRemovePrivate',
            'Private key is in Bitwarden: remove it here'
          )}
        </Button>
      </div>
      {publicKey ? (
        <div className="space-y-1">
          <code className="block select-all break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px]">
            {publicKey}
          </code>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void window.api.ui.writeClipboardText(publicKey)}
            >
              <Copy />
              {translate('aiborg.clientProfile.wizard.copyKey', 'Copy')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void window.api.shell.openUrl(`https://${host}/settings/ssh/new`)}
            >
              <ExternalLink />
              {translate('aiborg.clientProfile.wizard.addToGithub', 'Add to GitHub')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function GitHubStep({ profile, tools, bitwardenUnlocked }: StepProps): React.JSX.Element {
  if (!tools.gh) {
    return (
      <p className="text-sm text-muted-foreground">
        {translate(
          'aiborg.clientProfile.wizard.ghSkipped',
          'GitHub CLI was not selected for this profile.'
        )}
      </p>
    )
  }
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-xs font-medium">
          {translate(
            'aiborg.clientProfile.wizard.ghPat',
            'Preferred: a fine-grained token scoped to the allowed orgs'
          )}
        </p>
        <SecretFor profile={profile} name={GH_TOKEN_SECRET} bitwardenUnlocked={bitwardenUnlocked} />
      </div>
      <ClientProfileSetupCommandRow
        profileId={profile.id}
        label={translate('aiborg.clientProfile.wizard.ghLogin', 'Or sign in with the GitHub CLI')}
        command={loginCommandFor('gh', profile)}
      />
      <ClientProfileSetupCommandRow
        profileId={profile.id}
        label={translate(
          'aiborg.clientProfile.wizard.ghVerify',
          'Check which account this profile uses'
        )}
        command={GH_VERIFY_COMMAND}
      />
    </div>
  )
}

function loginHint(tool: ClientProfileSetupTool): string | undefined {
  if (tool === 'claude') {
    return translate(
      'aiborg.clientProfile.wizard.claudeHint',
      'Type /login once Claude Code starts.'
    )
  }
  if (tool === 'aws') {
    return translate(
      'aiborg.clientProfile.wizard.awsHint',
      'The AWS CLI keeps its SSO token cache in your own ~/.aws folder, so it is shared with your personal account and stays after the profile is deleted.'
    )
  }
  return undefined
}

export function LoginsStep({ profile, tools, bitwardenUnlocked }: StepProps): React.JSX.Element {
  const loginTools = CLIENT_PROFILE_SETUP_TOOLS.filter(
    (tool) => tools[tool] && tool !== 'gh' && tool !== 'supabase'
  )
  return (
    <div className="space-y-4">
      {loginTools.map((tool) => (
        <ClientProfileSetupCommandRow
          key={tool}
          profileId={profile.id}
          label={clientProfileToolLabel(tool)}
          command={loginCommandFor(tool, profile)}
          hint={loginHint(tool)}
        />
      ))}
      {tools.supabase ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">{clientProfileToolLabel('supabase')}</p>
          <SecretFor
            profile={profile}
            name={SUPABASE_TOKEN_SECRET}
            bitwardenUnlocked={bitwardenUnlocked}
          />
        </div>
      ) : null}
      {loginTools.length === 0 && !tools.supabase ? (
        <p className="text-sm text-muted-foreground">
          {translate(
            'aiborg.clientProfile.wizard.noLogins',
            'No agent or cloud tools were selected.'
          )}
        </p>
      ) : null}
    </div>
  )
}
