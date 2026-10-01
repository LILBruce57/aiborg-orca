import { posix, win32 } from 'node:path'
import { AIBORG_BRAND } from '../../../shared/aiborg/brand'

/**
 * Where orcad looks for an installed AI-Borg to host its browser (hook H22). Upstream's list names
 * stock Orca's install paths, and Windows paths match case-insensitively, so orcad would launch a
 * side-by-side stock Orca.
 */
export function aiborgInstalledElectronCandidates(
  platform: NodeJS.Platform,
  homePath: string,
  environment: NodeJS.ProcessEnv
): string[] {
  const { productName, packageName } = AIBORG_BRAND
  if (platform === 'darwin') {
    const bundle = `${productName}.app`
    return [
      posix.join('/Applications', bundle, 'Contents', 'MacOS', productName),
      posix.join(homePath, 'Applications', bundle, 'Contents', 'MacOS', productName)
    ]
  }
  if (platform === 'win32') {
    // Why two folder names: electron-builder names a per-user install after the package name and
    // a per-machine one after the product name. The executable keeps upstream's Orca.exe.
    return [
      ...(environment.LOCALAPPDATA
        ? [win32.join(environment.LOCALAPPDATA, 'Programs', packageName, 'Orca.exe')]
        : []),
      ...(environment.ProgramFiles
        ? [win32.join(environment.ProgramFiles, productName, 'Orca.exe')]
        : [])
    ]
  }
  // Why only /opt: the orca-ide links in ~/.local/bin and /usr/bin may point at stock Orca.
  return [posix.join('/opt', productName, 'orca-ide')]
}
