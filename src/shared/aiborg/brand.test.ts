import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { AIBORG_BRAND, formatAiborgAttribution } from './brand'

const requireBrandMirror = createRequire(__filename)

describe('AI-Borg brand', () => {
  it('keeps the electron-builder CJS mirror identical to the TS source', () => {
    expect(requireBrandMirror('../../../config/aiborg/brand.cjs').AIBORG_BRAND).toEqual(
      AIBORG_BRAND
    )
  })

  it('never reuses stock Orca identifiers', () => {
    expect(AIBORG_BRAND.appId).not.toMatch(/stablyai/)
    expect(AIBORG_BRAND.userDataDirName.toLowerCase()).not.toBe('orca')
    expect(AIBORG_BRAND.daemonHostRootName.toLowerCase()).not.toBe('orca')
    expect(AIBORG_BRAND.protocolScheme).not.toBe('orca')
  })

  it('formats the MIT attribution', () => {
    expect(formatAiborgAttribution()).toBe('AI-Borg — based on Orca by Lovecast Inc. (MIT)')
  })
})
