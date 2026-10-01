// AI-Borg packaging identity, applied on top of upstream's electron-builder config (hook H1 at the
// end of config/electron-builder.config.cjs). Every value here keeps an AI-Borg install from
// colliding with a stock Orca install on the same machine.
const { resolve } = require('node:path')
const { AIBORG_BRAND } = require('./brand.cjs')
const { isUpstreamBehaviorUnderTest } = require('./upstream-behavior-seam.cjs')

const ICON_DIR = 'resources/aiborg'
// Why shipped as resources: MIT requires the upstream notice to travel with every copy.
const LICENSE_RESOURCES = [
  { from: 'LICENSE', to: 'LICENSE' },
  { from: 'NOTICE', to: 'NOTICE' }
]

// Why: upstream's launcher execs Contents/MacOS/Orca; AI-Borg.app's executable is MacOS/AI-Borg.
const UPSTREAM_MAC_CLI_LAUNCHER = 'resources/darwin/bin/orca'
const AIBORG_MAC_CLI_LAUNCHER = 'resources/aiborg/darwin/bin/orca'

function withAiborgMacCliLauncher(macConfig) {
  return {
    ...macConfig,
    extraResources: (macConfig?.extraResources ?? []).map((resource) =>
      resource?.from === UPSTREAM_MAC_CLI_LAUNCHER
        ? { ...resource, from: AIBORG_MAC_CLI_LAUNCHER }
        : resource
    )
  }
}

function withLicenseResources(platformConfig) {
  return {
    ...platformConfig,
    extraResources: [...(platformConfig?.extraResources ?? []), ...LICENSE_RESOURCES]
  }
}

/**
 * @param {import('electron-builder').Configuration} base
 * @returns {import('electron-builder').Configuration}
 */
function applyAiborgBuilderOverrides(base) {
  // Why: lets upstream's config suites keep asserting upstream values.
  if (isUpstreamBehaviorUnderTest()) {
    return base
  }
  const prefix = AIBORG_BRAND.artifactPrefix
  return {
    ...base,
    appId: AIBORG_BRAND.appId,
    productName: AIBORG_BRAND.productName,
    // Why a distinct scheme: claiming orca:// would steal stock Orca's links.
    protocols: [{ name: AIBORG_BRAND.productName, schemes: [AIBORG_BRAND.protocolScheme] }],
    // Why `name`: it sets the install folder (%LOCALAPPDATA%\Programs\aiborg) and default userData.
    extraMetadata: { ...base.extraMetadata, name: AIBORG_BRAND.packageName },
    // Icons are packaging inputs only; keep them out of app.asar.
    files: [...(base.files ?? []), '!resources/aiborg{,/**/*}'],
    win: {
      ...withLicenseResources(base.win),
      // Why still Orca.exe: the native CLI launcher and daemon-host relocation resolve that name.
      icon: `${ICON_DIR}/icon.ico`
    },
    nsis: {
      ...base.nsis,
      artifactName: `${prefix}-windows-setup.\${ext}`,
      // Why our own include: upstream's kills every Orca.exe, deletes Orca's daemon host and
      // rewrites Orca's Markdown ProgID on uninstall, which would break a side-by-side Orca.
      include: resolve(__dirname, 'nsis', 'aiborg-installer-hooks.nsh')
    },
    mac: {
      ...withLicenseResources(withAiborgMacCliLauncher(base.mac)),
      icon: `${ICON_DIR}/icon.icns`
    },
    dmg: { ...base.dmg, artifactName: `${prefix}-macos-\${arch}.\${ext}` },
    linux: { ...withLicenseResources(base.linux), icon: `${ICON_DIR}/icon.icns` },
    appImage: { ...base.appImage, artifactName: `${prefix}-linux-\${arch}.\${ext}` },
    deb: {
      ...base.deb,
      packageName: prefix,
      artifactName: `${prefix}_\${version}_\${arch}.\${ext}`
    },
    rpm: {
      ...base.rpm,
      packageName: prefix,
      artifactName: `${prefix}-\${version}.\${arch}.\${ext}`
    },
    // Why null: no app-update.yml pointing at upstream's release feed is packaged.
    publish: null
  }
}

module.exports = { applyAiborgBuilderOverrides }
