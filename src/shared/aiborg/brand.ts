/**
 * AI-Borg product identity. Everything that must differ from stock Orca so both apps install and
 * run side by side reads from here.
 *
 * Why mirrored in config/aiborg/brand.cjs: electron-builder loads CJS outside the TS build.
 * brand.test.ts keeps the two in lockstep.
 */
export const AIBORG_BRAND = {
  productName: 'AI-Borg',
  // Why reverse-DNS distinct from com.stablyai.orca: NSIS derives the uninstall GUID from it and
  // Windows groups taskbar entries and notifications by the AppUserModelID it sets.
  appId: 'be.aiborg.desktop',
  // Packaged package.json `name`: drives the install folder and Electron's default userData name.
  packageName: 'aiborg',
  userDataDirName: 'aiborg',
  // %LOCALAPPDATA%\<this>\daemon-host; mirrored in config/aiborg/nsis/aiborg-installer-hooks.nsh.
  daemonHostRootName: 'AI-Borg',
  protocolScheme: 'aiborg',
  artifactPrefix: 'aiborg',
  upstream: {
    name: 'Orca',
    copyrightHolder: 'Lovecast Inc.',
    copyrightYear: 2026,
    license: 'MIT',
    repoUrl: 'https://github.com/stablyai/orca'
  }
} as const

export function formatAiborgAttribution(): string {
  const { upstream } = AIBORG_BRAND
  return `${AIBORG_BRAND.productName} — based on ${upstream.name} by ${upstream.copyrightHolder} (${upstream.license})`
}
