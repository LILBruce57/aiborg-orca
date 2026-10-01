// T16 renderer half (design §5.3, H53): opening a worktree triggers the client-profile check.
// The check lives in the always-mounted banner (one watcher on activeWorktreeId) so the core
// activation module stays identical to upstream.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('T16 activation checks the client profile', () => {
  it('the banner runs the check whenever the active worktree changes', () => {
    const banner = read('src/renderer/src/aiborg/ClientProfileMismatchBanner.tsx')
    expect(banner).toMatch(/useAppStore\(\(s\) => s\.activeWorktreeId\)/)
    expect(banner).toMatch(
      /useEffect\(\(\) => \{\s*if \(activeWorktreeId\) \{\s*checkClientProfileForWorktree\(activeWorktreeId\)\s*\}\s*\}, \[activeWorktreeId\]\)/
    )
  })

  it('the core activation module carries no AI-Borg hook', () => {
    expect(read('src/renderer/src/lib/worktree-activation.ts')).not.toMatch(/aiborg|ClientProfile/)
  })

  it('the banner is mounted in the workspace shell', () => {
    expect(read('src/renderer/src/app-shell/AppWorkspaceShell.tsx')).toMatch(
      /<ClientProfileMismatchBanner \/>/
    )
  })
})
