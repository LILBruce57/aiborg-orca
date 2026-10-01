// Pins every guardrail hook (ARCHITECTURE-NOTES §8) to its upstream call site, and each touched
// file to docs/aiborg/PATCHES.md, so an upstream merge that drops a one-line hook fails here.
// Names follow the implementation (see docs/aiborg/PATCHES.md §1c), where they differ from the design.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')

type CallSite = { hook: string; file: string; pattern: RegExp; count?: number }

const CALL_SITES: CallSite[] = [
  // H48 (Codex resume home) is checked inside the H20/H21 call.
  {
    hook: 'H20/H48',
    file: 'src/main/ipc/pty/ipc/spawn-options.ts',
    pattern: /applyClientProfileEnvToRendererSpawn\(/
  },
  {
    hook: 'H21',
    file: 'src/main/ipc/pty/runtime/spawn-options.ts',
    pattern: /applyClientProfileEnvToRuntimeSpawn\(/
  },
  {
    hook: 'H23/H33',
    file: 'src/main/claude/claude-structured-launch-resolution.ts',
    pattern: /assertAccountHomeAllowed/
  },
  {
    hook: 'H34',
    file: 'src/main/codex/codex-structured-launch-resolution.ts',
    pattern: /assertStructuredClientProfileHome\(/
  },
  {
    hook: 'H24',
    file: 'src/main/codex/codex-structured-launch-resolution.ts',
    pattern: /withStructuredClientProfileInvocation\(/
  },
  // The children also inherit main's process.env; the profile's deletes must leave that layer.
  {
    hook: 'H31',
    file: 'src/main/claude/claude-stream-json-connection.ts',
    pattern: /stripClientProfileInheritedEnv\(/
  },
  {
    hook: 'H31b',
    file: 'src/main/codex/codex-app-server-connection.ts',
    pattern: /stripClientProfileInheritedEnv\(/
  },
  {
    hook: 'H31c',
    file: 'src/main/codex/codex-app-server-session.ts',
    pattern: /stripClientProfileInheritedEnv\(/
  },
  // Live structured children per profile, for the delete flow's in-use check.
  {
    hook: 'H31d',
    file: 'src/main/claude/claude-stream-json-connection.ts',
    pattern: /trackClientProfileStructuredChild\(/
  },
  {
    hook: 'H31d',
    file: 'src/main/codex/codex-app-server-connection.ts',
    pattern: /trackClientProfileStructuredChild\(/
  },
  {
    hook: 'H22e',
    file: 'src/main/ipc/pty/provider/state-cleanup.ts',
    pattern: /forgetClientProfilePtyBinding\(/
  },
  {
    hook: 'H25',
    file: 'src/main/text-generation/source-control-agent-launch.ts',
    pattern: /withClientProfileEnv\(/
  },
  { hook: 'H26', file: 'src/main/hooks.ts', pattern: /prepareClientProfileHookEnv\(/ },
  {
    hook: 'H27/H47',
    file: 'src/main/git/command-runner/git-exec-file.ts',
    pattern: /withClientProfileGitEnv\(/g,
    count: 2
  },
  {
    hook: 'H28',
    file: 'src/main/git/command-runner/git-spawn.ts',
    pattern: /withClientProfileGitEnv\(/
  },
  {
    hook: 'H28b',
    file: 'src/main/git/command-runner/git-stream-stdout.ts',
    pattern: /withClientProfileGitEnv\(/
  },
  // The args make it the central GitHub write guard (H54) as well.
  {
    hook: 'H29/H54',
    file: 'src/main/git/command-runner/gh-exec-file.ts',
    pattern: /withClientProfileGhEnv\([^\n]*,\s*args\)/
  },
  {
    hook: 'H60c',
    file: 'src/main/rate-limits/codex-fetcher.ts',
    pattern: /withClientProfileCodexHomeEnv\(|withClientProfileCodexUsageHome\(/g,
    count: 2
  },
  {
    hook: 'H60d',
    file: 'src/main/codex/codex-app-server-client.ts',
    pattern: /withClientProfileCodexTrustGrantEnv\(/
  },
  {
    hook: 'H60e',
    file: 'src/main/codex/codex-state-db-backfill-recovery.ts',
    pattern: /withClientProfileCodexHomeEnv\(/
  },
  {
    hook: 'H42',
    file: 'src/renderer/src/components/status-bar/StatusBarSurface.tsx',
    pattern: /useClientProfileModeActive\(/
  },
  {
    hook: 'H32',
    file: 'src/main/runtime/structured-agent-account-home.ts',
    pattern: /from '[./]+\/aiborg\//
  },
  {
    hook: 'H49',
    file: 'src/main/notebook/notebook-kernel.ts',
    pattern: /withClientProfileEnv\(/
  },
  {
    hook: 'H50',
    file: 'src/main/git/remote.ts',
    pattern: /assertClientProfilePushTarget\(/
  },
  {
    hook: 'H51',
    file: 'src/main/git/fork-sync.ts',
    pattern: /assertClientProfilePushTarget\(/
  },
  {
    hook: 'H52',
    file: 'src/main/ipc/filesystem/git-remote/branch-mutation-handlers.ts',
    pattern: /assertClientProfileSshPush\(/
  },
  {
    hook: 'H52',
    file: 'src/main/runtime/runtime-git-sync-commands.ts',
    pattern: /assertClientProfileSshPush\(/
  },
  {
    hook: 'H54',
    file: 'src/main/github/client/create/create-github-pull-request.ts',
    pattern: /assertGitHubWriteAllowed\(/
  },
  {
    hook: 'H54',
    file: 'src/main/github/client/create/add-pr-review-comment.ts',
    pattern: /assertGitHubWriteAllowed\(/
  },
  {
    hook: 'H54',
    file: 'src/main/github/issue-comment.ts',
    pattern: /assertGitHubWriteAllowed\(/
  },
  {
    hook: 'H54',
    file: 'src/main/github/client/merge/merge-pr.ts',
    pattern: /assertGitHubWriteAllowed\(/
  },
  {
    hook: 'H54',
    file: 'src/main/github/client/merge/pr-auto-merge.ts',
    pattern: /assertGitHubWriteAllowed\(/
  },
  {
    hook: 'H54',
    file: 'src/main/github/github-pr-stack-async-merge.ts',
    pattern: /assertGitHubWriteAllowed\(/
  },
  {
    hook: 'H53',
    file: 'src/renderer/src/aiborg/ClientProfileMismatchBanner.tsx',
    pattern: /checkClientProfileForWorktree\(activeWorktreeId\)/g,
    count: 1
  },
  {
    hook: 'H61',
    file: 'src/renderer/src/components/cmd-j/quick-actions.ts',
    pattern: /\.\.\.getClientProfileOverviewQuickActions\(\)/
  }
]

/** Drops comment-only lines, so prose about a hook is not mistaken for the hook. */
function code(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

describe('guardrail hook call sites', () => {
  it.each(CALL_SITES)('$hook is present in $file', ({ file, pattern, count }) => {
    const matches = code(file).match(pattern) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(count ?? 1)
  })

  it('lists every touched upstream file in docs/aiborg/PATCHES.md', () => {
    const ledger = readFileSync(join(REPO_ROOT, 'docs', 'aiborg', 'PATCHES.md'), 'utf8')
    const missing = [...new Set(CALL_SITES.map((site) => site.file))].filter(
      (file) => !ledger.includes(file)
    )
    expect(missing).toEqual([])
  })
})
