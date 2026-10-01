import { vi } from 'vitest'

// Why: a test that forgets its own fake must never read or write the developer's real OS keychain.
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    constructor() {
      throw new Error('real OS keychain blocked in tests; mock @napi-rs/keyring')
    }
  }
}))
