import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

// Why fs instead of `git rev-parse` / `git remote`: resolution runs on Electron main for every
// git and gh call Orca makes, and a process spawn there freezes the UI (Windows: 30-100 ms each).

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readFirstLine(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/)[0]?.trim() || null
  } catch {
    return null
  }
}

function resolveFrom(base: string, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(base, target)
}

/** `<gitdir>/commondir` points linked worktrees and submodule worktrees at the shared dir. */
function commonDirOf(gitDir: string): string {
  const common = readFirstLine(join(gitDir, 'commondir'))
  return common ? resolveFrom(gitDir, common) : resolve(gitDir)
}

function gitDirAt(dir: string): string | null {
  const dotGit = join(dir, '.git')
  if (isDirectory(dotGit)) {
    return dotGit
  }
  if (isFile(dotGit)) {
    const line = readFirstLine(dotGit)
    const match = line?.match(/^gitdir:\s*(.+)$/)
    return match ? resolveFrom(dir, match[1].trim()) : null
  }
  return null
}

function looksLikeBareRepo(dir: string): boolean {
  return isFile(join(dir, 'HEAD')) && isDirectory(join(dir, 'objects'))
}

/** The shared git dir for `path` and every worktree of its repo; null outside a repo. */
export function findGitCommonDir(path: string): string | null {
  let dir = resolve(path)
  for (;;) {
    const gitDir = gitDirAt(dir)
    if (gitDir) {
      return commonDirOf(gitDir)
    }
    if (looksLikeBareRepo(dir)) {
      return commonDirOf(dir)
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

type Section = { name: string; subsection: string | null }

function parseSectionHeader(line: string): { section: Section; rest: string } | null {
  const quoted = line.match(/^\[\s*([A-Za-z0-9.-]+)\s+"((?:[^"\\]|\\.)*)"\s*\](.*)$/)
  if (quoted) {
    return {
      section: { name: quoted[1].toLowerCase(), subsection: quoted[2].replace(/\\(.)/g, '$1') },
      rest: quoted[3]
    }
  }
  const plain = line.match(/^\[\s*([A-Za-z0-9.-]+)\s*\](.*)$/)
  if (!plain) {
    return null
  }
  // Legacy `[remote.origin]` form.
  const [name, ...sub] = plain[1].split('.')
  return {
    section: { name: name.toLowerCase(), subsection: sub.length > 0 ? sub.join('.') : null },
    rest: plain[2]
  }
}

/** A gitconfig value: comments end it outside quotes; `\"`, `\\`, `\t`, `\n` are escapes. */
function parseConfigValue(raw: string): string {
  let out = ''
  let pendingSpace = ''
  let quoted = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (!quoted && (ch === '#' || ch === ';')) {
      break
    }
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[++i]
      out += pendingSpace + (next === 't' ? '\t' : next === 'n' ? '\n' : next)
      pendingSpace = ''
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      pendingSpace = out ? pendingSpace + ch : ''
      continue
    }
    out += pendingSpace + ch
    pendingSpace = ''
  }
  return out
}

export type GitRemotePushUrls = { name: string; pushUrls: string[] }

/** Push URLs per remote: `pushurl` entries when present, else `url`. */
export function parseGitConfigRemotePushUrls(configText: string): GitRemotePushUrls[] {
  const remotes = new Map<string, { urls: string[]; pushUrls: string[] }>()
  let section: Section | null = null
  for (const rawLine of configText.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (line.startsWith('[')) {
      const header = parseSectionHeader(line)
      section = header?.section ?? null
      line = header?.rest.trim() ?? ''
    }
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue
    }
    if (section?.name !== 'remote' || section.subsection === null) {
      continue
    }
    const entry = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/)
    const key = entry?.[1].toLowerCase()
    if (!entry || (key !== 'url' && key !== 'pushurl')) {
      continue
    }
    const value = parseConfigValue(entry[2])
    const remote = remotes.get(section.subsection) ?? { urls: [], pushUrls: [] }
    ;(key === 'url' ? remote.urls : remote.pushUrls).push(value)
    remotes.set(section.subsection, remote)
  }
  return [...remotes.entries()].map(([name, remote]) => ({
    name,
    pushUrls: remote.pushUrls.length > 0 ? remote.pushUrls : remote.urls
  }))
}

/** True for config the fs reader cannot follow (`include` / `includeIf`). */
export function gitConfigHasIncludes(configText: string): boolean {
  return /^\s*\[\s*include(if)?\b/im.test(configText)
}
