// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import type {
  ClientProfile,
  ClientProfileListEntry,
  ClientProfilesState
} from '../../../shared/aiborg/client-profile-types'
import { applyClientProfilePaneBorders } from './client-profile-pane-border'
import { applyClientProfileDocumentIdentity } from './client-profile-document-identity'
import {
  checkClientProfileForWorktree,
  findClientProfileMismatch,
  markWorktreeReadOnly,
  useClientProfileMismatchStore
} from './check-client-profile-for-worktree'
import { applyClientProfilesState, useClientProfileStore } from './client-profile-store'

function profile(id: string, color: string, org: string): ClientProfile {
  return {
    schemaVersion: 1,
    id,
    name: id === 'acme' ? 'Acme' : 'Contoso',
    color,
    github: { host: 'github.com', allowedOrgs: [org] },
    git: { userName: 'Example Name', userEmail: `dev@${id}.example` }
  }
}

function entry(p: ClientProfile, boundRepoIds: string[] = []): ClientProfileListEntry {
  return {
    id: p.id,
    fileName: `${p.id}.json`,
    profile: p,
    errors: [],
    secretStatus: {},
    boundRepoIds
  }
}

function state(overrides: Partial<ClientProfilesState> = {}): ClientProfilesState {
  return {
    enabled: true,
    profilesDir: '/tmp/profiles',
    profilesDirSource: 'sidecar',
    profilesDirWritable: true,
    profilesDirError: null,
    profilesRoot: '/tmp/profiles-root',
    activeProfileId: 'acme',
    keychainAvailable: true,
    profiles: [
      entry(profile('acme', '#2f80ed', 'acme-inc')),
      entry(profile('contoso', '#eb5757', 'contoso-org'))
    ],
    repoBindings: { 'repo-contoso': 'contoso', 'repo-acme': 'acme' },
    ptyBindings: { 'pty-1': 'acme', 'pty-2': 'contoso', 'pty-3': 'deleted' },
    ...overrides
  }
}

afterEach(() => {
  useClientProfileMismatchStore.setState({
    pending: null,
    readOnlyWorktreeIds: new Set()
  })
  useClientProfileStore.setState({
    snapshot: null,
    loadError: null,
    resolvedRepoProfiles: {}
  })
})

describe('client profile store', () => {
  it('keeps resolved org matches across terminal-only changes, and drops them on an org edit', () => {
    applyClientProfilesState(state())
    useClientProfileStore.setState({ resolvedRepoProfiles: { 'repo-x': 'acme' } })
    applyClientProfilesState(state({ ptyBindings: { 'pty-9': 'acme' } }))
    expect(useClientProfileStore.getState().resolvedRepoProfiles).toEqual({ 'repo-x': 'acme' })
    applyClientProfilesState(
      state({
        profiles: [
          entry(profile('acme', '#2f80ed', 'acme-labs')),
          entry(profile('contoso', '#eb5757', 'contoso-org'))
        ]
      })
    )
    expect(useClientProfileStore.getState().resolvedRepoProfiles).toEqual({})
  })
})

describe('pane border', () => {
  it('colours each pane from ptyBindings, never from the active profile', () => {
    const panes = [1, 2, 3, 4].map((id) => ({
      id,
      container: document.createElement('div')
    }))
    const ptyIds: Record<number, string | null> = {
      1: 'pty-1',
      2: 'pty-2',
      3: 'pty-3',
      4: null
    }
    applyClientProfilePaneBorders(
      panes,
      (id) => ptyIds[id] ?? null,
      state({ activeProfileId: 'contoso' })
    )

    expect(panes[0].container.dataset.aiborgProfile).toBe('acme')
    expect(panes[0].container.style.getPropertyValue('--aiborg-pane-color')).toBe('#2f80ed')
    expect(panes[1].container.dataset.aiborgProfile).toBe('contoso')
    expect(panes[2].container.dataset.aiborgProfile).toBe('deleted')
    expect(panes[2].container.style.getPropertyValue('--aiborg-pane-color')).toBe('')
    expect(panes[3].container.dataset.aiborgProfile).toBeUndefined()
  })
})

describe('document identity', () => {
  it('sets the stripe colour and title for a profile and clears them for personal mode', () => {
    const root = document.createElement('html')
    expect(
      applyClientProfileDocumentIdentity(root, {
        id: 'acme',
        name: 'Acme',
        color: '#2f80ed'
      })
    ).toBe('AI-Borg · Acme')
    expect(root.dataset.aiborgProfile).toBe('acme')
    expect(root.style.getPropertyValue('--aiborg-profile')).toBe('#2f80ed')
    expect(applyClientProfileDocumentIdentity(root, null)).toBe('AI-Borg')
    expect(root.dataset.aiborgProfile).toBeUndefined()
  })
})

describe('repo under another profile', () => {
  it('reports a contoso repo opened under acme, including in personal mode', () => {
    expect(findClientProfileMismatch(state(), 'repo-contoso::/w/contoso')).toEqual({
      worktreeId: 'repo-contoso::/w/contoso',
      repoProfileId: 'contoso',
      activeProfileId: 'acme'
    })
    expect(findClientProfileMismatch(state(), 'repo-acme::/w/acme')).toBeNull()
    expect(
      findClientProfileMismatch(state({ activeProfileId: null }), 'repo-acme::/w/acme')
        ?.repoProfileId
    ).toBe('acme')
    expect(findClientProfileMismatch(state(), 'repo-unbound::/w/x')).toBeNull()
    expect(
      findClientProfileMismatch(state({ enabled: false }), 'repo-contoso::/w/contoso')
    ).toBeNull()
  })

  it('uses a resolved org match when there is no explicit binding', () => {
    expect(
      findClientProfileMismatch(state({ repoBindings: {} }), 'repo-x::/w/x', {
        'repo-x': 'contoso'
      })?.repoProfileId
    ).toBe('contoso')
  })

  it('queues the warning dialog once, and not again after "open read-only"', () => {
    applyClientProfilesState(state())
    checkClientProfileForWorktree('repo-contoso::/w/contoso')
    expect(useClientProfileMismatchStore.getState().pending?.repoProfileId).toBe('contoso')
    markWorktreeReadOnly('repo-contoso::/w/contoso')
    checkClientProfileForWorktree('repo-contoso::/w/contoso')
    expect(useClientProfileMismatchStore.getState().pending).toBeNull()
  })
})
