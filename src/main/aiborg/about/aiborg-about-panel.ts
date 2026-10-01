import { app } from 'electron'
import { AIBORG_BRAND, formatAiborgAttribution } from '../../../shared/aiborg/brand'

/**
 * Adds the MIT attribution to upstream's About panel options (hook H7), keeping its GPU line.
 *
 * Why per platform: Electron shows `credits` only on macOS/Windows and `website` only on Linux,
 * where upstream already uses `copyright` for the GPU status.
 */
export function withAiborgAboutAttribution(
  options: Electron.AboutPanelOptionsOptions,
  platform: NodeJS.Platform
): Electron.AboutPanelOptionsOptions {
  const attribution = formatAiborgAttribution()
  const repoUrl = AIBORG_BRAND.upstream.repoUrl
  if (platform === 'linux') {
    return {
      ...options,
      copyright: [attribution, options.copyright].filter(Boolean).join('\n'),
      website: repoUrl
    }
  }
  return {
    ...options,
    copyright: attribution,
    credits: [repoUrl, options.credits].filter(Boolean).join('\n')
  }
}

/** H7 call site: upstream's About options go here instead of straight to Electron. */
export function setAiborgAboutPanelOptions(options: Electron.AboutPanelOptionsOptions): void {
  app.setAboutPanelOptions(withAiborgAboutAttribution(options, process.platform))
}
