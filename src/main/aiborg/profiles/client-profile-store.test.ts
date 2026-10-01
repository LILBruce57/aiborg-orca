import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClientProfileSidecarStore, normalizeClientProfileSidecar } from './client-profile-sidecar'
import { ClientProfileStore, resolveClientProfilesDir } from './client-profile-store'

const temps: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiborg-store-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function profileJson(id: string, orgs: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    name: id,
    color: '#2F80ED',
    github: { allowedOrgs: orgs },
    git: { userName: 'Example Name', userEmail: `dev@${id}.example` },
    ...extra
  })
}

describe('ClientProfileSidecarStore', () => {
  it('normalizes junk and keeps only valid ids', () => {
    expect(
      normalizeClientProfileSidecar({
        activeProfileId: 'Not Valid',
        repoBindings: { r1: 'acme', r2: 42, r3: '../x' },
        storedSecretNames: { acme: ['GH_TOKEN', 7] }
      })
    ).toMatchObject({
      activeProfileId: null,
      repoBindings: { r1: 'acme' },
      storedSecretNames: { acme: ['GH_TOKEN'] }
    })
  })

  it('persists bindings and secret names, and removes a profile cleanly', () => {
    const dir = temp()
    const sidecar = new ClientProfileSidecarStore(
      join(dir, 'userData', 'aiborg-client-profiles.json')
    )
    sidecar.setActiveProfileId('acme')
    sidecar.setRepoBinding('repo-1', 'acme')
    sidecar.setPtyBinding('wt@@abc', 'acme')
    sidecar.setPtyBinding('wt@@def', 'contoso')
    sidecar.recordSecretName('acme', 'GH_TOKEN')
    sidecar.recordSecretName('acme', 'GH_TOKEN')
    const reloaded = new ClientProfileSidecarStore(sidecar.filePath)
    expect(reloaded.read()).toMatchObject({
      activeProfileId: 'acme',
      repoBindings: { 'repo-1': 'acme' },
      storedSecretNames: { acme: ['GH_TOKEN'] }
    })
    reloaded.removeProfile('acme')
    expect(reloaded.read()).toMatchObject({
      activeProfileId: null,
      repoBindings: {},
      ptyBindings: { 'wt@@def': 'contoso' },
      storedSecretNames: {}
    })
  })

  it('keeps a copy of a corrupt file instead of silently losing secret names', () => {
    const dir = temp()
    const path = join(dir, 'aiborg-client-profiles.json')
    writeFileSync(path, '{not json')
    expect(new ClientProfileSidecarStore(path).read().activeProfileId).toBeNull()
    expect(readdirSync(dir).some((name) => name.includes('.corrupt-'))).toBe(true)
  })
})

describe('ClientProfileStore', () => {
  it('prefers AIBORG_PROFILES_DIR over the sidecar value', () => {
    expect(
      resolveClientProfilesDir('/from/sidecar', { AIBORG_PROFILES_DIR: '/from/env' })
    ).toMatchObject({ source: 'env' })
    expect(resolveClientProfilesDir('/from/sidecar', {})).toMatchObject({ source: 'sidecar' })
    expect(resolveClientProfilesDir(null, {})).toEqual({ dir: null, source: null })
  })

  it('loads valid profiles, reports invalid ones and invalidates duplicate orgs', () => {
    const dir = temp()
    writeFileSync(join(dir, 'acme.json'), profileJson('acme', ['acme-inc']))
    writeFileSync(
      join(dir, 'contoso.json'),
      profileJson('contoso', ['contoso-org'], { env: { CONTOSO_REGION: 'west' } })
    )
    writeFileSync(join(dir, 'broken.json'), '{')
    writeFileSync(join(dir, 'notes.txt'), 'ignored')
    const store = new ClientProfileStore(() => null, { AIBORG_PROFILES_DIR: dir })
    store.reload()
    expect(store.validProfiles().map((p) => p.id)).toEqual(['acme', 'contoso'])
    expect(store.snapshot().entries.find((e) => e.id === 'broken')?.errors[0]).toMatch(
      /unreadable JSON/
    )
    expect(store.managedKeyUnion()).toEqual(['CONTOSO_REGION'])

    writeFileSync(join(dir, 'contoso.json'), profileJson('contoso', ['contoso-org', 'acme-inc']))
    store.reload()
    expect(store.getProfile('acme')).toBeNull()
    expect(
      store
        .snapshot()
        .entries.find((e) => e.id === 'contoso')
        ?.errors.join()
    ).toMatch(/also listed in: acme/)
  })

  it('writes and deletes profile files in the profiles dir', () => {
    const dir = temp()
    mkdirSync(join(dir, 'clients'))
    const store = new ClientProfileStore(() => join(dir, 'clients'), {})
    store.reload()
    const raw = JSON.parse(profileJson('acme', ['acme-inc']))
    store.writeProfile(raw)
    expect(JSON.parse(readFileSync(join(dir, 'clients', 'acme.json'), 'utf8')).id).toBe('acme')
    expect(store.getProfile('acme')?.name).toBe('acme')
    store.deleteProfileFile('acme')
    expect(store.getProfile('acme')).toBeNull()
  })
})
