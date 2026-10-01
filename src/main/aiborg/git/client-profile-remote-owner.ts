import { parseHostedRemote } from '../../git/hosted-remote-url'
import { AIBORG_BLOCKED_SCHEME } from '../profiles/client-profile-git-templates'

export type RemoteOwner = { host: string; owner: string; rewrittenToBlocked: boolean }

function firstSegment(path: string): string | null {
  const segment = path.replace(/^\/+/, '').split('/')[0]
  if (!segment) {
    return null
  }
  try {
    return decodeURIComponent(segment).toLowerCase()
  } catch {
    return segment.toLowerCase()
  }
}

/**
 * Owner (org or user) of a push URL. Handles URLs already rewritten by the profile's
 * `pushInsteadOf` (`aiborg-blocked://owner/...`) and GitHub Enterprise hosts.
 */
export function parseRemoteOwner(remoteUrl: string): RemoteOwner | null {
  const url = remoteUrl.trim()
  const blockedPrefix = `${AIBORG_BLOCKED_SCHEME}://`
  if (url.startsWith(blockedPrefix)) {
    const owner = firstSegment(url.slice(blockedPrefix.length))
    return owner ? { host: '', owner, rewrittenToBlocked: true } : null
  }
  const hosted = parseHostedRemote(url)
  if (hosted?.provider === 'github') {
    const owner = firstSegment(hosted.path)
    return owner ? { host: hosted.host, owner, rewrittenToBlocked: false } : null
  }
  // Why 2+ chars: `C:/repo` is a Windows drive path, not an scp-style host.
  const scpLike = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
    ? null
    : url.match(/^(?:[^@/:]+@)?([^:\s/]{2,}):(.+)$/)
  if (scpLike) {
    const owner = firstSegment(scpLike[2])
    return owner && scpLike[2].includes('/')
      ? { host: scpLike[1].toLowerCase(), owner, rewrittenToBlocked: false }
      : null
  }
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) {
      return null
    }
    const owner = firstSegment(parsed.pathname)
    return owner && parsed.pathname.replace(/^\/+/, '').includes('/')
      ? { host: parsed.hostname.toLowerCase(), owner, rewrittenToBlocked: false }
      : null
  } catch {
    return null
  }
}
