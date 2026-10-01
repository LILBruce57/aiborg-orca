import { Checkbox } from '@/components/ui/checkbox'
import { ColorPicker } from '@/components/ui/color-picker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  CLIENT_PROFILE_SETUP_TOOLS,
  type ClientProfileSetupTool,
  type NewClientProfileForm
} from './new-client-profile-form'
import { clientProfileToolLabel } from './client-profile-tool-labels'

type IdentityStepProps = {
  form: NewClientProfileForm
  onChange: (next: NewClientProfileForm) => void
  bitwardenAvailable: boolean
}

type TextField = Exclude<keyof NewClientProfileForm, 'tools'>

export function NewClientProfileIdentityStep({
  form,
  onChange,
  bitwardenAvailable
}: IdentityStepProps): React.JSX.Element {
  const field = (key: TextField, label: string, placeholder?: string): React.JSX.Element => (
    <div className="space-y-1">
      <Label htmlFor={`aiborg-new-${key}`}>{label}</Label>
      <Input
        id={`aiborg-new-${key}`}
        value={form[key]}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange({ ...form, [key]: event.target.value })}
      />
    </div>
  )
  const setTool = (tool: ClientProfileSetupTool, enabled: boolean): void =>
    onChange({ ...form, tools: { ...form.tools, [tool]: enabled } })

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {field('id', translate('aiborg.clientProfile.wizard.id', 'Id'), 'acme')}
        {field('name', translate('aiborg.clientProfile.wizard.name', 'Name'), 'Acme')}
      </div>
      <ColorPicker
        value={form.color}
        onChange={(color) => onChange({ ...form, color })}
        label={translate('aiborg.clientProfile.wizard.color', 'Colour')}
        triggerLabel={translate('aiborg.clientProfile.wizard.color', 'Colour')}
        showHexInTrigger
      />
      <div className="grid grid-cols-2 gap-3">
        {field('githubHost', translate('aiborg.clientProfile.wizard.githubHost', 'GitHub host'))}
        {field(
          'allowedOrgs',
          translate('aiborg.clientProfile.wizard.allowedOrgs', 'Allowed orgs'),
          'acme-inc, acme-labs'
        )}
        {field('gitUserName', translate('aiborg.clientProfile.wizard.gitName', 'Git name'))}
        {field(
          'gitUserEmail',
          translate('aiborg.clientProfile.wizard.gitEmail', 'Git email'),
          'dev@acme.example'
        )}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium">
          {translate('aiborg.clientProfile.wizard.tools', 'Tools to set up')}
        </p>
        <div className="grid grid-cols-3 gap-2">
          {CLIENT_PROFILE_SETUP_TOOLS.map((tool) => (
            <div key={tool} className="flex items-center gap-2">
              <Checkbox
                id={`aiborg-new-tool-${tool}`}
                checked={form.tools[tool]}
                onCheckedChange={(checked) => setTool(tool, checked === true)}
              />
              <Label htmlFor={`aiborg-new-tool-${tool}`}>{clientProfileToolLabel(tool)}</Label>
            </div>
          ))}
        </div>
      </div>
      {form.tools.aws ? (
        <div className="grid grid-cols-2 gap-3">
          {field('awsProfile', translate('aiborg.clientProfile.wizard.awsProfile', 'AWS profile'))}
          {field('awsRegion', translate('aiborg.clientProfile.wizard.awsRegion', 'AWS region'))}
        </div>
      ) : null}
      {form.tools.gcloud
        ? field(
            'gcloudProject',
            translate('aiborg.clientProfile.wizard.gcloudProject', 'Google Cloud project')
          )
        : null}
      {bitwardenAvailable && (form.tools.gh || form.tools.supabase) ? (
        <div className="grid grid-cols-2 gap-3">
          {form.tools.gh
            ? field(
                'ghTokenBitwarden',
                translate(
                  'aiborg.clientProfile.wizard.ghTokenItem',
                  'Bitwarden item: GitHub token'
                ),
                translate('aiborg.clientProfile.wizard.optional', 'Optional')
              )
            : null}
          {form.tools.supabase
            ? field(
                'supabaseBitwarden',
                translate(
                  'aiborg.clientProfile.wizard.supabaseItem',
                  'Bitwarden item: Supabase token'
                ),
                translate('aiborg.clientProfile.wizard.optional', 'Optional')
              )
            : null}
        </div>
      ) : null}
    </div>
  )
}
