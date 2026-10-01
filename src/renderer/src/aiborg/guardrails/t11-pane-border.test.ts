// @vitest-environment happy-dom
// T11 renderer half (design §4.1 "The border colour always comes from ptyBindings", §6 terminal border).
import { describe, expect, it } from 'vitest'
import type { ClientProfilesState } from '../../../../shared/aiborg/client-profile-types'
import { applyClientProfilePaneBorders } from '@/aiborg/client-profile-pane-border'

const ACME_COLOR = '#2F80ED'
const CONTOSO_COLOR = '#EB5757'

function snapshot(
  activeProfileId: string | null,
  ptyBindings: Record<string, string>
): ClientProfilesState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the border reads only ptyBindings, activeProfileId and profiles[].id/profile.color.
  return {
    enabled: true,
    activeProfileId,
    ptyBindings,
    repoBindings: {},
    profiles: [
      { id: 'acme', profile: { id: 'acme', color: ACME_COLOR } },
      { id: 'contoso', profile: { id: 'contoso', color: CONTOSO_COLOR } }
    ]
  } as unknown as ClientProfilesState
}

function panes() {
  return [1, 2, 3].map((id) => ({
    id,
    container: document.createElement('div')
  }))
}

const PTY_BY_PANE: Record<number, string | null> = {
  1: 'pty-acme',
  2: 'pty-contoso',
  3: null
}

describe('T11 terminal border', () => {
  it('paints each pane with its PTY’s bound profile, not the active one', () => {
    const list = panes()
    applyClientProfilePaneBorders(
      list,
      (id) => PTY_BY_PANE[id],
      snapshot('contoso', { 'pty-acme': 'acme', 'pty-contoso': 'contoso' })
    )
    expect(list[0].container.dataset.aiborgProfile).toBe('acme')
    expect(list[0].container.style.getPropertyValue('--aiborg-pane-color')).toBe(ACME_COLOR)
    expect(list[1].container.dataset.aiborgProfile).toBe('contoso')
    expect(list[1].container.style.getPropertyValue('--aiborg-pane-color')).toBe(CONTOSO_COLOR)
    expect(list[2].container.dataset.aiborgProfile).toBeUndefined()
  })

  it('keeps every pane’s colour when the active profile switches', () => {
    const list = panes()
    const bindings = { 'pty-acme': 'acme', 'pty-contoso': 'contoso' }
    applyClientProfilePaneBorders(list, (id) => PTY_BY_PANE[id], snapshot('contoso', bindings))
    applyClientProfilePaneBorders(list, (id) => PTY_BY_PANE[id], snapshot('acme', bindings))
    applyClientProfilePaneBorders(list, (id) => PTY_BY_PANE[id], snapshot(null, bindings))
    expect(list[0].container.dataset.aiborgProfile).toBe('acme')
    expect(list[1].container.dataset.aiborgProfile).toBe('contoso')
  })

  it('clears the border once the binding is gone', () => {
    const list = panes()
    applyClientProfilePaneBorders(
      list,
      (id) => PTY_BY_PANE[id],
      snapshot('acme', { 'pty-acme': 'acme' })
    )
    applyClientProfilePaneBorders(list, (id) => PTY_BY_PANE[id], snapshot('acme', {}))
    expect(list[0].container.dataset.aiborgProfile).toBeUndefined()
    expect(list[0].container.style.getPropertyValue('--aiborg-pane-color')).toBe('')
  })
})
