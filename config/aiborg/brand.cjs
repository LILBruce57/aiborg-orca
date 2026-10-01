// CJS mirror of src/shared/aiborg/brand.ts for electron-builder; brand.test.ts keeps them equal.
const AIBORG_BRAND = {
  productName: 'AI-Borg',
  appId: 'be.aiborg.desktop',
  packageName: 'aiborg',
  userDataDirName: 'aiborg',
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
}

module.exports = { AIBORG_BRAND }
