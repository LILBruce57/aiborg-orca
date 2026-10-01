import { describe, expect, it } from 'vitest'
import { loginCommandFor, sshKeygenCommand } from './client-profile-setup-commands'

const acme = {
  github: { host: 'github.com', allowedOrgs: ['acme-inc'] },
  aws: { profile: 'acme-dev' }
}

describe('client profile setup commands', () => {
  it('builds the per-tool login commands', () => {
    expect(loginCommandFor('gh', acme)).toBe(
      'gh auth login --hostname github.com --git-protocol ssh --insecure-storage'
    )
    expect(loginCommandFor('codex', acme)).toBe('codex login')
    expect(loginCommandFor('aws', acme)).toBe('aws configure sso --profile acme-dev')
    expect(loginCommandFor('azure', acme)).toBe('az login')
    expect(loginCommandFor('gcloud', acme)).toBe('gcloud auth login')
    expect(loginCommandFor('supabase', acme)).toBeNull()
  })

  it('refuses values that are not shell-safe', () => {
    expect(loginCommandFor('aws', { ...acme, aws: { profile: 'acme; rm -rf ~' } })).toBeNull()
    expect(loginCommandFor('aws', { github: acme.github })).toBeNull()
    expect(sshKeygenCommand('dev"@acme.example', '/tmp/p/acme/ssh/id_ed25519')).toBeNull()
    expect(sshKeygenCommand('dev@acme.example', '/tmp/$(whoami)/id_ed25519')).toBeNull()
  })

  it('quotes the key path for Windows and POSIX homes', () => {
    expect(
      sshKeygenCommand(
        'dev@acme.example',
        'C:\\Users\\example\\.aiborg\\profiles\\acme\\ssh\\id_ed25519'
      )
    ).toBe(
      'ssh-keygen -t ed25519 -C "dev@acme.example" -f "C:\\Users\\example\\.aiborg\\profiles\\acme\\ssh\\id_ed25519"'
    )
    expect(
      sshKeygenCommand('dev@acme.example', '/home/example/.aiborg/profiles/acme/ssh/id_ed25519')
    ).toBe(
      'ssh-keygen -t ed25519 -C "dev@acme.example" -f "/home/example/.aiborg/profiles/acme/ssh/id_ed25519"'
    )
  })
})
