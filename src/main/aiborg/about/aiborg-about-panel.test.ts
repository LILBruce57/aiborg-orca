import { describe, expect, it, vi } from 'vitest'

const { setAboutPanelOptions } = vi.hoisted(() => ({ setAboutPanelOptions: vi.fn() }))
vi.mock('electron', () => ({ app: { setAboutPanelOptions } }))

import { setAiborgAboutPanelOptions, withAiborgAboutAttribution } from './aiborg-about-panel'

const ATTRIBUTION = 'AI-Borg — based on Orca by Lovecast Inc. (MIT)'
const REPO = 'https://github.com/stablyai/orca'

describe('withAiborgAboutAttribution', () => {
  it.each(['darwin', 'win32'] satisfies NodeJS.Platform[])(
    'puts the attribution in copyright and keeps the GPU line in credits on %s',
    (platform) => {
      expect(
        withAiborgAboutAttribution(
          {
            applicationName: 'AI-Borg',
            applicationVersion: '1.2.3',
            credits: 'GPU acceleration: Enabled'
          },
          platform
        )
      ).toEqual({
        applicationName: 'AI-Borg',
        applicationVersion: '1.2.3',
        copyright: ATTRIBUTION,
        credits: `${REPO}\nGPU acceleration: Enabled`
      })
    }
  )

  it('prefixes the Linux copyright field and links the upstream repo', () => {
    expect(
      withAiborgAboutAttribution(
        { applicationName: 'AI-Borg', copyright: 'GPU acceleration: Enabled' },
        'linux'
      )
    ).toEqual({
      applicationName: 'AI-Borg',
      copyright: `${ATTRIBUTION}\nGPU acceleration: Enabled`,
      website: REPO
    })
  })

  it('hands Electron upstream’s options with the attribution added (H7 call site)', () => {
    setAiborgAboutPanelOptions({ applicationName: 'AI-Borg', credits: 'GPU acceleration: Enabled' })
    expect(setAboutPanelOptions).toHaveBeenCalledWith(
      withAiborgAboutAttribution(
        { applicationName: 'AI-Borg', credits: 'GPU acceleration: Enabled' },
        process.platform
      )
    )
  })
})
