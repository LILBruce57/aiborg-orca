import type React from 'react'

/** Inline style carrying a profile colour as a CSS variable; aiborg.css reads it. */
export function profileDotStyle(color: string): React.CSSProperties {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: React forwards custom properties verbatim; CSSProperties just has no key for them.
  return { '--aiborg-dot-color': color } as React.CSSProperties
}
