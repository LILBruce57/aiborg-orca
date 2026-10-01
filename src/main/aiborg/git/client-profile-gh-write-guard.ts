import { assertGitHubWriteAllowed } from './assert-github-write-allowed'

const words = (list: string): readonly string[] => list.split(' ')

// gh subcommands that change GitHub state. Reads (list, view, status, checks, diff) pass.
const WRITE_VERBS: Readonly<Record<string, readonly string[]>> = {
  pr: words('create edit close reopen merge comment review ready lock unlock update-branch'),
  issue: words('create edit close reopen comment delete lock unlock transfer pin unpin develop'),
  release: words('create edit delete upload delete-asset'),
  label: words('create edit delete clone'),
  repo: words('create edit delete rename archive unarchive fork sync'),
  workflow: words('run enable disable'),
  run: words('rerun cancel delete'),
  secret: words('set delete'),
  variable: words('set delete'),
  cache: words('delete'),
  project: words(
    'create edit delete close copy link unlink mark-template field-create field-delete ' +
      'item-add item-archive item-create item-delete item-edit'
  )
}

const API_VALUE_FLAGS = new Set(
  words('-X --method -H --header -f --raw-field -F --field --input -q --jq -t --template').concat(
    words('--cache --hostname -p --preview')
  )
)
const API_FIELD_FLAGS = new Set(words('-f --raw-field -F --field'))
const WRITE_METHODS = new Set(words('POST PUT PATCH DELETE'))
const OWNER_FIELD_NAMES = new Set(words('owner org login'))

export type GhWriteOperation = `${string}.${string}`

export type GhWriteClassification =
  | { write: false }
  | { write: true; operation: GhWriteOperation; owner: string | null }

function ownerFromRepoArg(value: string): string | null {
  const parts = value.split('/').filter(Boolean)
  // `owner/repo` or `host/owner/repo`.
  return parts.length >= 2 ? (parts.at(-2)?.toLowerCase() ?? null) : null
}

function repoFlagOwner(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if ((arg === '--repo' || arg === '-R') && i + 1 < args.length) {
      return ownerFromRepoArg(args[i + 1])
    }
    if (arg.startsWith('--repo=')) {
      return ownerFromRepoArg(arg.slice('--repo='.length))
    }
  }
  return null
}

function classifyApi(args: readonly string[]): GhWriteClassification {
  let method: string | null = null
  let endpoint: string | null = null
  let hasBody = false
  const fields: [string, string][] = []
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    if (/^-X.+/.test(arg)) {
      method = arg.slice(2).toUpperCase()
      continue
    }
    if (API_VALUE_FLAGS.has(flag)) {
      const value = eq > 0 ? arg.slice(eq + 1) : (args[++i] ?? '')
      if (flag === '-X' || flag === '--method') {
        method = value.toUpperCase()
      } else if (API_FIELD_FLAGS.has(flag)) {
        hasBody = true
        const sep = value.indexOf('=')
        fields.push(sep !== -1 ? [value.slice(0, sep), value.slice(sep + 1)] : [value, ''])
      } else if (flag === '--input') {
        hasBody = true
      }
      continue
    }
    if (!arg.startsWith('-') && endpoint === null) {
      endpoint = arg
    }
  }
  const path = (endpoint ?? '').replace(/^\/+/, '')
  if (path === 'graphql') {
    const query = fields.find(([name]) => name === 'query')?.[1] ?? ''
    if (!/^\s*mutation\b/.test(query.replace(/#[^\n]*/g, ''))) {
      return { write: false }
    }
    const ownerField = fields.find(([name]) => OWNER_FIELD_NAMES.has(name))?.[1]
    return {
      write: true,
      operation: 'api.graphql-mutation',
      owner: ownerField?.toLowerCase() || null
    }
  }
  // gh api sends POST once fields are given, unless a method says otherwise.
  const effective = method ?? (hasBody ? 'POST' : 'GET')
  if (!WRITE_METHODS.has(effective)) {
    return { write: false }
  }
  const owner = path.match(/^repos\/([^/?]+)\//)?.[1]?.toLowerCase() ?? null
  return { write: true, operation: `api.${effective.toLowerCase()}`, owner }
}

/** Pure: whether gh `args` change GitHub state, and the owner they target when the args say so. */
export function classifyGhWrite(args: readonly string[]): GhWriteClassification {
  const [command, verb] = args
  if (command === 'api') {
    return classifyApi(args)
  }
  if (command && verb && WRITE_VERBS[command]?.includes(verb)) {
    return {
      write: true,
      operation: `${command}.${verb}`,
      owner: repoFlagOwner(args)
    }
  }
  return { write: false }
}

/**
 * H54 (central): every gh write Orca makes is checked against the profile's allowedOrgs, so a
 * write path without its own guard (stacked PRs, issue edits, reruns, project mutations) cannot
 * reach another org under a client identity. Without an owner in the args, every owner of the
 * cwd repo's remotes must be allowed (gh may pick any as the base repo).
 */
export function assertGhCommandWriteAllowed(
  args: readonly string[],
  cwd: string | undefined,
  cwdOwners: (cwd: string) => readonly string[]
): void {
  const classified = classifyGhWrite(args)
  if (!classified.write) {
    return
  }
  const owners = classified.owner ? [classified.owner] : cwd ? [...cwdOwners(cwd)] : []
  for (const owner of owners.length > 0 ? owners : ['']) {
    assertGitHubWriteAllowed({
      owner,
      operation: classified.operation,
      repoPath: cwd ?? null
    })
  }
}
