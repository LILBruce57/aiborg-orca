export type ClientProfileRefusalCode =
  | 'profile-mismatch'
  | 'profile-unavailable'
  | 'ssh-not-allowed'
  | 'wsl-unsupported'
  | 'orcad-unsupported'
  | 'env-unavailable'
  | 'account-home-mismatch'
  | 'push-blocked'
  | 'github-write-blocked'

/** A client profile cannot be applied correctly, so the action is refused (design: fail closed). */
export class ClientProfileRefusalError extends Error {
  readonly code: ClientProfileRefusalCode
  readonly profileId: string | null

  constructor(code: ClientProfileRefusalCode, profileId: string | null, message: string) {
    super(message)
    this.name = 'ClientProfileRefusalError'
    this.code = code
    this.profileId = profileId
  }
}

export function isClientProfileRefusalError(error: unknown): error is ClientProfileRefusalError {
  return error instanceof Error && error.name === 'ClientProfileRefusalError'
}
