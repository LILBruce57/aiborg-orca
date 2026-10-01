import { z } from 'zod'
import type {
  ClientProfileOverviewBranch,
  ClientProfileOverviewItem,
  ClientProfileOverviewOrg,
  ClientProfileOverviewProblem
} from '../../../shared/aiborg/client-profile-overview-types'

// One GraphQL read per refresh: four searches per allowed org plus recent branches of the
// profile's known repos, so a refresh spends one request of the profile's gh quota. Searches are
// per org so one unreadable org (SSO, renamed, no access) cannot blank the others.

export const OVERVIEW_SEARCH_PAGE = 30
export const OVERVIEW_BRANCHES_PER_REPO = 5

export type OverviewRepoRef = { owner: string; name: string }

const SEARCH_ALIASES = ['authored', 'assigned', 'review', 'issues'] as const

type SearchAlias = (typeof SEARCH_ALIASES)[number]

const SEARCHES: Record<SearchAlias, string> = {
  authored: 'is:pr is:open archived:false author:@me',
  assigned: 'is:pr is:open archived:false assignee:@me',
  review: 'is:pr is:open archived:false review-requested:@me',
  issues: 'is:issue is:open archived:false assignee:@me'
}

const ITEM_FIELDS = 'number title url updatedAt author { login } repository { nameWithOwner }'
const TOKEN_SHAPE_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g

/** First non-empty line, with anything token-shaped removed; gh output never reaches the renderer raw. */
export function redactOverviewDetail(text: string, fallback = 'gh failed'): string {
  const line = text.split(/\r?\n/).find((entry) => entry.trim()) ?? ''
  return line.replace(TOKEN_SHAPE_RE, '[redacted]').trim().slice(0, 300) || fallback
}

function searchAlias(orgIndex: number, alias: SearchAlias): string {
  return `o${orgIndex}_${alias}`
}

// Why `user:` and not `org:`: it matches organizations and personal accounts alike, so an allowed
// owner that is a user account does not fail its searches.
function searchSelection(alias: SearchAlias, org: string, orgIndex: number): string {
  const query = `${SEARCHES[alias]} user:${org} sort:updated-desc`
  return (
    `${searchAlias(orgIndex, alias)}: search(type: ISSUE, query: ${JSON.stringify(query)}, first: ${OVERVIEW_SEARCH_PAGE}) ` +
    `{ issueCount nodes { __typename ... on PullRequest { ${ITEM_FIELDS} isDraft } ... on Issue { ${ITEM_FIELDS} } } }`
  )
}

function repoSelection(repo: OverviewRepoRef, index: number): string {
  return (
    `repo${index}: repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) ` +
    `{ nameWithOwner url refs(refPrefix: "refs/heads/", first: ${OVERVIEW_BRANCHES_PER_REPO}, ` +
    `orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name target { ... on Commit { committedDate } } } } }`
  )
}

/** Orgs come from the validated profile, so JSON string literals are safe GraphQL strings. */
export function buildOverviewQuery(
  orgs: readonly string[],
  repos: readonly OverviewRepoRef[]
): string {
  const searches = orgs.flatMap((org, index) =>
    SEARCH_ALIASES.map((alias) => searchSelection(alias, org, index))
  )
  return `query { viewer { login } ${[...searches, ...repos.map(repoSelection)].join(' ')} }`
}

const itemSchema = z.object({
  __typename: z.string().optional(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  isDraft: z.boolean().optional(),
  author: z.object({ login: z.string() }).nullish(),
  repository: z.object({ nameWithOwner: z.string() })
})

const searchSchema = z.object({ issueCount: z.number(), nodes: z.array(z.unknown()) }).nullish()

const repoSchema = z
  .object({
    nameWithOwner: z.string(),
    url: z.string(),
    refs: z
      .object({
        nodes: z.array(
          z.object({
            name: z.string(),
            target: z.object({ committedDate: z.string().optional() }).nullish()
          })
        )
      })
      .nullish()
  })
  .nullish()

export const overviewEnvelopeSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z
    .array(
      z.object({
        message: z.string().optional(),
        type: z.string().optional(),
        path: z.array(z.union([z.string(), z.number()])).optional()
      })
    )
    .optional()
})

export type OverviewEnvelope = z.infer<typeof overviewEnvelopeSchema>

type EnvelopeError = NonNullable<OverviewEnvelope['errors']>[number]

/** Only https links on the profile's own host may reach the renderer's open-in-browser. */
function isProfileHostUrl(url: string, host: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === host
  } catch {
    return false
  }
}

function ownerOf(nameWithOwner: string): string {
  return nameWithOwner.split('/')[0]?.toLowerCase() ?? ''
}

type ParsedList = { items: ClientProfileOverviewItem[]; full: boolean }

/** null when GitHub returned no list: an error for that section, never "nothing open". */
function parseItems(raw: unknown, host: string): ParsedList | null {
  const search = searchSchema.safeParse(raw)
  if (!search.success || !search.data) {
    return null
  }
  const items: ClientProfileOverviewItem[] = []
  for (const node of search.data.nodes) {
    const item = itemSchema.safeParse(node)
    if (!item.success || !isProfileHostUrl(item.data.url, host)) {
      continue
    }
    items.push({
      kind: item.data.__typename === 'Issue' ? 'issue' : 'pr',
      repo: item.data.repository.nameWithOwner,
      number: item.data.number,
      title: item.data.title,
      url: item.data.url,
      updatedAt: item.data.updatedAt,
      isDraft: item.data.isDraft === true,
      author: item.data.author?.login ?? null
    })
  }
  return { items, full: search.data.issueCount > search.data.nodes.length }
}

function branchUrl(repoUrl: string, name: string): string {
  return `${repoUrl}/tree/${name.split('/').map(encodeURIComponent).join('/')}`
}

function parseBranches(raw: unknown, host: string): ClientProfileOverviewBranch[] | null {
  const repo = repoSchema.safeParse(raw)
  if (!repo.success || !repo.data || !isProfileHostUrl(repo.data.url, host)) {
    return null
  }
  const { nameWithOwner, url } = repo.data
  return (repo.data.refs?.nodes ?? []).map((ref) => ({
    repo: nameWithOwner,
    name: ref.name,
    url: branchUrl(url, ref.name),
    committedAt: ref.target?.committedDate ?? null
  }))
}

function mergeUnique(
  a: readonly ClientProfileOverviewItem[],
  b: readonly ClientProfileOverviewItem[]
): ClientProfileOverviewItem[] {
  const seen = new Set(a.map((item) => item.url))
  return [...a, ...b.filter((item) => !seen.has(item.url))].sort((x, y) =>
    y.updatedAt.localeCompare(x.updatedAt)
  )
}

const PROBLEM_RANK: readonly ClientProfileOverviewProblem['kind'][] = [
  'sso',
  'forbidden',
  'not-found',
  'failed'
]

function problemKind(error: EnvelopeError): ClientProfileOverviewProblem['kind'] {
  const message = error.message ?? ''
  if (/SAML|\bSSO\b/i.test(message)) {
    return 'sso'
  }
  if (error.type === 'FORBIDDEN' || /forbidden|permission/i.test(message)) {
    return 'forbidden'
  }
  if (
    error.type === 'NOT_FOUND' ||
    /could not resolve|cannot be searched|do not exist/i.test(message)
  ) {
    return 'not-found'
  }
  return 'failed'
}

/** Most actionable kind wins (SSO says what to do); messages are redacted and de-duplicated. */
function combineProblems(errors: readonly EnvelopeError[]): ClientProfileOverviewProblem | null {
  if (errors.length === 0) {
    return null
  }
  const kinds = new Set(errors.map(problemKind))
  const kind = PROBLEM_RANK.find((rank) => kinds.has(rank)) ?? 'failed'
  const messages = [
    ...new Set(errors.map((error) => redactOverviewDetail(error.message ?? '', '')))
  ].filter(Boolean)
  return { kind, message: messages.slice(0, 3).join(' · ').slice(0, 300) }
}

/** The allowed org an error belongs to, from its GraphQL path (`o<i>_…` or `repo<i>`). */
function errorOrg(
  error: EnvelopeError,
  orgs: readonly string[],
  repos: readonly OverviewRepoRef[]
): string | null {
  const head = String(error.path?.[0] ?? '')
  const search = /^o(\d+)_/.exec(head)
  if (search) {
    return orgs[Number(search[1])] ?? null
  }
  const repo = /^repo(\d+)$/.exec(head)
  return repo ? (repos[Number(repo[1])]?.owner.toLowerCase() ?? null) : null
}

/** A list or repo that came back empty-handed without a GitHub error message. */
const UNREADABLE: EnvelopeError = { message: '' }

export type ParsedOverview = {
  viewerLogin: string | null
  orgs: ClientProfileOverviewOrg[]
  partial: boolean
  problem: ClientProfileOverviewProblem | null
}

/**
 * Groups the response per allowed org. Anything owned by another org is dropped even if the
 * search returned it: the panel shows the active profile's orgs only.
 */
export function parseOverviewResponse(
  envelope: OverviewEnvelope,
  orgs: readonly string[],
  repos: readonly OverviewRepoRef[],
  host: string
): ParsedOverview {
  const data = envelope.data ?? {}
  const viewer = z.object({ login: z.string() }).safeParse(data.viewer)
  const errorsByOrg = new Map<string, EnvelopeError[]>(orgs.map((org) => [org, []]))
  const unattributed: EnvelopeError[] = []
  for (const error of envelope.errors ?? []) {
    const org = errorOrg(error, orgs, repos)
    const bucket = org === null ? undefined : errorsByOrg.get(org)
    if (bucket) {
      bucket.push(error)
    } else {
      unattributed.push(error)
    }
  }
  const branches: ClientProfileOverviewBranch[] = []
  repos.forEach((repo, index) => {
    const parsed = parseBranches(data[`repo${index}`], host)
    if (parsed) {
      branches.push(...parsed)
    } else {
      errorsByOrg.get(repo.owner.toLowerCase())?.push(UNREADABLE)
    }
  })
  let partial = false
  const inOrg = <T extends { repo: string }>(org: string, list: readonly T[]): T[] =>
    list.filter((entry) => ownerOf(entry.repo) === org)
  const grouped = orgs.map((org, index): ClientProfileOverviewOrg => {
    const errors = errorsByOrg.get(org) ?? []
    const items = (alias: SearchAlias): ClientProfileOverviewItem[] => {
      const list = parseItems(data[searchAlias(index, alias)], host)
      if (!list) {
        errors.push(UNREADABLE)
      }
      partial ||= list?.full === true
      return list?.items ?? []
    }
    const pullRequests = mergeUnique(items('authored'), items('assigned'))
    const reviewRequests = items('review')
    const issues = items('issues')
    return {
      org,
      problem: combineProblems(errors),
      pullRequests: inOrg(org, pullRequests),
      reviewRequests: inOrg(org, reviewRequests),
      issues: inOrg(org, issues),
      branches: inOrg(org, branches)
    }
  })
  return {
    viewerLogin: viewer.success ? viewer.data.login : null,
    partial,
    orgs: grouped,
    problem: combineProblems(unattributed)
  }
}
