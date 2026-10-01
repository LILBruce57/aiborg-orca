import { useState } from 'react'
import { Copy, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { runInClientProfileSetupTerminal } from './client-profile-setup-terminal'

type ClientProfileSetupCommandRowProps = {
  profileId: string
  label: string
  command: string | null
  hint?: string
}

/** One setup command, run in a terminal bound to the profile so it only ever sees that profile. */
export function ClientProfileSetupCommandRow({
  profileId,
  label,
  command,
  hint
}: ClientProfileSetupCommandRowProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    if (!command) {
      return
    }
    setBusy(true)
    try {
      const result = await runInClientProfileSetupTerminal(profileId, command)
      if (result === 'floating-terminal-disabled') {
        toast.message(
          translate(
            'aiborg.clientProfile.setup.floatingDisabled',
            'Turn on the floating terminal in Settings, or copy the command into a terminal of this profile.'
          )
        )
      }
    } catch (error) {
      toast.error(
        translate('aiborg.clientProfile.setup.runFailed', 'Could not start the setup terminal'),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      setBusy(false)
    }
  }

  const copy = (): void => {
    if (command) {
      void window.api.ui
        .writeClipboardText(command)
        .then(() => toast.success(translate('aiborg.clientProfile.setup.copied', 'Command copied')))
    }
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{label}</p>
      {command ? (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1 font-mono text-[11px]">
            {command}
          </code>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => void run()}
          >
            <SquareTerminal />
            {translate('aiborg.clientProfile.setup.run', 'Run in setup terminal')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('aiborg.clientProfile.setup.copy', 'Copy command')}
            onClick={copy}
          >
            <Copy />
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate(
            'aiborg.clientProfile.setup.unavailable',
            'Not available: fill in the matching profile field first.'
          )}
        </p>
      )}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
