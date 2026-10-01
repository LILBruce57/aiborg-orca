import {
  CircleDot,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  GitPullRequestDraft,
  TriangleAlert
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import type {
  ClientProfileOverviewBranch,
  ClientProfileOverviewItem,
  ClientProfileOverviewOrg
} from '../../../shared/aiborg/client-profile-overview-types'
import { overviewOrgProblemText } from './client-profile-overview-display'

function openInBrowser(url: string): void {
  void window.api.shell.openUrl(url)
}

function ItemIcon({ item }: { item: ClientProfileOverviewItem }): React.JSX.Element {
  if (item.kind === 'issue') {
    return <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return item.isDraft ? (
    <GitPullRequestDraft className="size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
  )
}

function OverviewRow({
  icon,
  title,
  meta,
  url
}: {
  icon: React.ReactNode
  title: string
  meta: string
  url: string
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        className="group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
        onClick={() => openInBrowser(url)}
        title={url}
      >
        <span className="mt-0.5">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">{meta}</span>
        </span>
        <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
      </button>
    </li>
  )
}

function itemMeta(item: ClientProfileOverviewItem): string {
  const updated = formatUiRelativeTimeFromDate(item.updatedAt)
  const draft = item.isDraft
    ? ` · ${translate('aiborg.clientProfile.overview.draft', 'Draft')}`
    : ''
  return `${item.repo}#${item.number}${draft} · ${updated}`
}

function branchMeta(branch: ClientProfileOverviewBranch): string {
  return branch.committedAt
    ? `${branch.repo} · ${formatUiRelativeTimeFromDate(branch.committedAt)}`
    : branch.repo
}

function OverviewSubsection({
  label,
  count,
  children
}: {
  label: string
  count: number
  children: React.ReactNode
}): React.JSX.Element | null {
  if (count === 0) {
    return null
  }
  return (
    <section className="space-y-1">
      <h4 className="px-2 text-xs font-medium text-muted-foreground">
        {label} <span className="tabular-nums">({count})</span>
      </h4>
      <ul>{children}</ul>
    </section>
  )
}

export function ClientProfileOverviewOrgSection({
  org,
  host
}: {
  org: ClientProfileOverviewOrg
  host: string
}): React.JSX.Element {
  const total =
    org.pullRequests.length + org.reviewRequests.length + org.issues.length + org.branches.length
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 px-2">
        <h3 className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {org.org}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('aiborg.clientProfile.overview.openOrg', 'Open {{org}} on GitHub', {
            org: org.org
          })}
          onClick={() => openInBrowser(`https://${host}/${encodeURIComponent(org.org)}`)}
        >
          <ExternalLink />
        </Button>
      </div>
      {org.problem ? (
        <p className="flex items-start gap-2 px-2 text-xs break-words text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            {overviewOrgProblemText(org.problem, org.org)} {org.problem.message}
          </span>
        </p>
      ) : null}
      {total === 0 && !org.problem ? (
        <p className="px-2 text-xs text-muted-foreground">
          {translate('aiborg.clientProfile.overview.orgEmpty', 'Nothing open for you here.')}
        </p>
      ) : null}
      <OverviewSubsection
        label={translate('aiborg.clientProfile.overview.pullRequests', 'Your pull requests')}
        count={org.pullRequests.length}
      >
        {org.pullRequests.map((item) => (
          <OverviewRow
            key={item.url}
            icon={<ItemIcon item={item} />}
            title={item.title}
            meta={itemMeta(item)}
            url={item.url}
          />
        ))}
      </OverviewSubsection>
      <OverviewSubsection
        label={translate('aiborg.clientProfile.overview.reviewRequests', 'Review requests')}
        count={org.reviewRequests.length}
      >
        {org.reviewRequests.map((item) => (
          <OverviewRow
            key={item.url}
            icon={<ItemIcon item={item} />}
            title={item.title}
            meta={itemMeta(item)}
            url={item.url}
          />
        ))}
      </OverviewSubsection>
      <OverviewSubsection
        label={translate('aiborg.clientProfile.overview.issues', 'Assigned issues')}
        count={org.issues.length}
      >
        {org.issues.map((item) => (
          <OverviewRow
            key={item.url}
            icon={<ItemIcon item={item} />}
            title={item.title}
            meta={itemMeta(item)}
            url={item.url}
          />
        ))}
      </OverviewSubsection>
      <OverviewSubsection
        label={translate('aiborg.clientProfile.overview.branches', 'Recent branches')}
        count={org.branches.length}
      >
        {org.branches.map((branch) => (
          <OverviewRow
            key={branch.url}
            icon={<GitBranch className="size-3.5 shrink-0 text-muted-foreground" />}
            title={branch.name}
            meta={branchMeta(branch)}
            url={branch.url}
          />
        ))}
      </OverviewSubsection>
    </section>
  )
}
