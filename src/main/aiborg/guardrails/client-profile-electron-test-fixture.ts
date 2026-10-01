// Minimal `electron` stand-in for main modules the guardrail suite loads. Use from a test file as:
//   vi.mock('electron', async () => (await import('./client-profile-electron-test-fixture')).electronModule)
import { vi, type Mock } from 'vitest'
import { getAppEnvironment, type AppPathName } from '../../../shared/app-environment'

/** safeStorage must never be touched by client profiles: there is no fallback (§2). */
export const safeStorageSpy = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((text: string) => Buffer.from(text)),
  decryptString: vi.fn((buffer: Buffer) => buffer.toString())
}

type MockFn = Mock<(...args: unknown[]) => unknown>

export const electronModule: {
  app: {
    getPath: (name: AppPathName) => string
    getVersion: () => string
    getName: () => string
    isPackaged: boolean
    on: MockFn
    whenReady: () => Promise<void>
  }
  ipcMain: Record<'handle' | 'on' | 'removeHandler' | 'removeAllListeners', MockFn>
  safeStorage: typeof safeStorageSpy
  shell: Record<'openPath' | 'openExternal', MockFn>
  BrowserWindow: { getAllWindows: () => never[] }
  webContents: { getAllWebContents: () => never[] }
} = {
  app: {
    getPath: (name: AppPathName) => getAppEnvironment().getPath(name),
    getVersion: () => '0.0.0-guardrail',
    getName: () => 'AI-Borg',
    isPackaged: false,
    on: vi.fn(),
    whenReady: () => Promise.resolve()
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  },
  safeStorage: safeStorageSpy,
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] }
}
