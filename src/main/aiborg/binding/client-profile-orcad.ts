import { setClientProfileCodexTrustGrantGate } from '../../../shared/aiborg/client-profile-codex-trust-gate'
import { clientProfileCodexTrustGrantEnv } from '../agents/client-profile-usage'
import {
  getClientProfileRuntime,
  initClientProfileRuntime
} from '../profiles/client-profile-runtime'
import {
  setClientProfileRepoSource,
  type ClientProfileRepoSource
} from './client-profile-resolution'

/** H22 (orcad): no keychain, so profile-bound spawns, git and agent starts are refused there. */
export function installOrcadClientProfileRefusal(
  repos: ClientProfileRepoSource,
  userDataPath: string
): void {
  if (!getClientProfileRuntime()) {
    initClientProfileRuntime({ userDataPath, mode: 'orcad' })
  }
  setClientProfileRepoSource('orcad', repos)
  setClientProfileCodexTrustGrantGate(clientProfileCodexTrustGrantEnv)
}
