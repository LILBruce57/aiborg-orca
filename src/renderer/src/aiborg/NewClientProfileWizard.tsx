import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { BitwardenStatus, ClientProfile } from '../../../shared/aiborg/client-profile-types'
import { getClientProfilesApi } from './client-profile-bridge'
import { applyClientProfilesState } from './client-profile-store'
import {
  buildClientProfileFromForm,
  createEmptyClientProfileForm,
  validateNewClientProfileForm,
  type NewClientProfileForm
} from './new-client-profile-form'
import { NewClientProfileIdentityStep } from './NewClientProfileIdentityStep'
import { GitHubStep, LoginsStep, SshKeyStep } from './NewClientProfileSetupSteps'

const STEPS = ['identity', 'ssh', 'github', 'logins'] as const
type WizardStep = (typeof STEPS)[number]

type NewClientProfileWizardProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingIds: readonly string[]
  bitwardenStatus: BitwardenStatus
}

function stepTitle(step: WizardStep): string {
  switch (step) {
    case 'identity':
      return translate('aiborg.clientProfile.wizard.stepIdentity', 'Client and identity')
    case 'ssh':
      return translate('aiborg.clientProfile.wizard.stepSsh', 'SSH key')
    case 'github':
      return translate('aiborg.clientProfile.wizard.stepGithub', 'GitHub access')
    case 'logins':
      return translate('aiborg.clientProfile.wizard.stepLogins', 'Agent and cloud logins')
  }
}

export function NewClientProfileWizard({
  open,
  onOpenChange,
  existingIds,
  bitwardenStatus
}: NewClientProfileWizardProps): React.JSX.Element {
  const [step, setStep] = useState<WizardStep>('identity')
  const [form, setForm] = useState<NewClientProfileForm>(createEmptyClientProfileForm)
  const [created, setCreated] = useState<ClientProfile | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const reset = (): void => {
    setStep('identity')
    setForm(createEmptyClientProfileForm())
    setCreated(null)
    setErrors([])
  }
  const close = (): void => {
    reset()
    onOpenChange(false)
  }

  const create = async (): Promise<void> => {
    const validation = validateNewClientProfileForm(form, existingIds)
    setErrors(validation)
    const api = getClientProfilesApi()
    if (validation.length > 0 || !api) {
      return
    }
    setBusy(true)
    try {
      const profile = buildClientProfileFromForm(form)
      const result = await api.saveProfile({ profile })
      if (!result.ok) {
        setErrors(result.errors)
        return
      }
      applyClientProfilesState(result.state)
      setCreated(profile)
      setStep('ssh')
    } catch (error) {
      setErrors([error instanceof Error ? error.message : String(error)])
    } finally {
      setBusy(false)
    }
  }

  const stepIndex = STEPS.indexOf(step)
  const stepProps = created
    ? {
        profile: created,
        tools: form.tools,
        bitwardenUnlocked: bitwardenStatus === 'unlocked'
      }
    : null

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {translate('aiborg.clientProfile.wizard.title', 'New client profile')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'aiborg.clientProfile.wizard.stepOf',
              'Step {{current}} of {{total}}: {{title}}',
              {
                current: stepIndex + 1,
                total: STEPS.length,
                title: stepTitle(step)
              }
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] min-h-0 overflow-y-auto scrollbar-sleek pr-1">
          {step === 'identity' ? (
            <NewClientProfileIdentityStep
              form={form}
              onChange={setForm}
              bitwardenAvailable={bitwardenStatus !== 'unavailable'}
            />
          ) : null}
          {stepProps && step !== 'identity' ? (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {translate(
                  'aiborg.clientProfile.wizard.setupTerminalNote',
                  'Setup commands run in a floating terminal bound to {{name}}. AI-Borg switches to this profile first.',
                  { name: stepProps.profile.name }
                )}
              </p>
              {step === 'ssh' ? <SshKeyStep {...stepProps} /> : null}
              {step === 'github' ? <GitHubStep {...stepProps} /> : null}
              {step === 'logins' ? <LoginsStep {...stepProps} /> : null}
            </div>
          ) : null}
          {errors.length > 0 ? (
            <ul role="alert" className="mt-3 space-y-0.5 text-xs text-destructive">
              {errors.map((error) => (
                <li key={error} className="break-words">
                  {error}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <DialogFooter>
          {step === 'identity' ? (
            <>
              <Button type="button" variant="ghost" onClick={close}>
                {translate('aiborg.clientProfile.wizard.cancel', 'Cancel')}
              </Button>
              <Button type="button" disabled={busy} onClick={() => void create()}>
                {translate('aiborg.clientProfile.wizard.create', 'Create profile')}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={close}>
                {translate('aiborg.clientProfile.wizard.finishLater', 'Finish later')}
              </Button>
              {stepIndex < STEPS.length - 1 ? (
                <Button type="button" onClick={() => setStep(STEPS[stepIndex + 1])}>
                  {translate('aiborg.clientProfile.wizard.next', 'Next')}
                </Button>
              ) : (
                <Button type="button" onClick={close}>
                  {translate('aiborg.clientProfile.wizard.done', 'Done')}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
