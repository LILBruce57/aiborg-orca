import { describe, expect, it } from 'vitest'
import { KEYBINDING_DEFINITIONS } from '../keybindings/definitions'
import {
  AIBORG_KEYBINDING_DEFINITIONS,
  CLIENT_PROFILE_SWITCH_ACTION_ID
} from './client-profile-keybindings'

describe('client profile keybindings', () => {
  it('defines Mod+Shift+P for the switcher on every platform', () => {
    expect(AIBORG_KEYBINDING_DEFINITIONS).toHaveLength(1)
    const [definition] = AIBORG_KEYBINDING_DEFINITIONS
    expect(definition.id).toBe(CLIENT_PROFILE_SWITCH_ACTION_ID)
    expect(definition.defaultBindings).toEqual({
      darwin: ['Mod+Shift+P'],
      linux: ['Mod+Shift+P'],
      win32: ['Mod+Shift+P']
    })
  })

  it('does not collide with an upstream default binding', () => {
    for (const upstream of KEYBINDING_DEFINITIONS.filter(
      (d) => String(d.id) !== CLIENT_PROFILE_SWITCH_ACTION_ID
    )) {
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        expect(upstream.defaultBindings[platform]).not.toContain('Mod+Shift+P')
      }
    }
  })
})
