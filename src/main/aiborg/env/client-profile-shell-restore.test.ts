import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from '../../powershell-osc133-bootstrap'
import {
  CLIENT_PROFILE_POWERSHELL_PROMPT_FILE,
  getClientProfileBashRestoreSnippet,
  getClientProfilePowerShellPromptScript,
  getClientProfilePowerShellRestoreSnippet,
  getClientProfileZshRestoreSnippet
} from './client-profile-shell-restore'

function zshAvailable(): boolean {
  return spawnSync('zsh', ['-c', 'exit 0'], { windowsHide: true }).status === 0
}

function writePromptScript(dir: string): void {
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(
    join(dir, 'bin', CLIENT_PROFILE_POWERSHELL_PROMPT_FILE),
    getClientProfilePowerShellPromptScript()
  )
}

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function profileShellEnv(dir: string): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(GIT_|AIBORG_)/i.test(key))
  )
  return {
    ...base,
    AIBORG_PROFILE_ID: 'acme',
    AIBORG_PROFILE_NAME: 'Acme $(touch pwned)',
    AIBORG_PROFILE_COLOR: '#2F80ED',
    AIBORG_PROFILE_BIN: join(dir, 'bin'),
    AIBORG_PROFILE_KEYS: 'GH_CONFIG_DIR',
    AIBORG_KEEP_GH_CONFIG_DIR: '/profile/gh',
    AIBORG_PROFILE_UNSET: 'GITHUB_TOKEN',
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: dir,
    // What a user startup file might have exported after Orca's env was applied:
    GH_CONFIG_DIR: '/personal/gh',
    GITHUB_TOKEN: 'ambient-personal'
  }
}

describe('client profile shell restore snippets', () => {
  it('are inert without AIBORG_PROFILE_ID', () => {
    expect(getClientProfileBashRestoreSnippet()).toContain(
      'if [ -n "${AIBORG_PROFILE_ID:-}" ]; then'
    )
    expect(getClientProfileZshRestoreSnippet()).toContain('${=${AIBORG_PROFILE_KEYS:-}}')
    expect(getClientProfilePowerShellRestoreSnippet()).toContain('if ($env:AIBORG_PROFILE_ID) {')
  })

  it('bash: re-exports kept keys, unsets deleted ones, restores P/bin and a sanitized prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiborg-restore-'))
    temps.push(dir)
    const script = join(dir, 'restore.sh')
    writeFileSync(
      script,
      `PS1='$ '\nPROMPT_COMMAND='PS1="fw$ "'\n${getClientProfileBashRestoreSnippet()}printf '%s|%s|%s\\n' "$GH_CONFIG_DIR" "\${GITHUB_TOKEN-unset}" "$PS1"\ncase ":$PATH:" in *"/bin:"*) echo path-ok ;; esac\n# A prompt framework rebuilds PS1 before each prompt; the label must come back, once.\neval "$PROMPT_COMMAND"; eval "$PROMPT_COMMAND"\nprintf '%s\\n' "$PS1"\n`.replaceAll(
        '\r\n',
        '\n'
      )
    )
    // Why a git alias: git runs `!` aliases with its own bash-capable sh on every platform.
    spawnSync('git', ['init', '--quiet'], {
      cwd: dir,
      env: profileShellEnv(dir),
      windowsHide: true
    })
    const result = spawnSync(
      'git',
      ['-c', `alias.aiborgrestore=!bash '${script.replaceAll('\\', '/')}'`, 'aiborgrestore'],
      {
        cwd: dir,
        env: profileShellEnv(dir),
        encoding: 'utf8',
        windowsHide: true
      }
    )
    expect(result.stderr).toBe('')
    const [line, pathLine, rebuilt] = result.stdout.trim().split('\n')
    const [ghDir, token, prompt] = line.split('|')
    expect(ghDir).toBe('/profile/gh')
    expect(token).toBe('unset')
    expect(prompt).toContain('38;2;47;128;237m')
    expect(prompt).toContain('[Acme touch pwned]')
    expect(pathLine).toBe('path-ok')
    expect(rebuilt.match(/\[Acme touch pwned\]/g)).toHaveLength(1)
    expect(rebuilt).toMatch(/fw\$$/)
    expect(existsSync(join(dir, 'pwned'))).toBe(false)
  })

  it.runIf(zshAvailable())('zsh: restores env and re-applies the label from a precmd hook', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiborg-restore-zsh-'))
    temps.push(dir)
    const script = join(dir, 'restore.zsh')
    writeFileSync(
      script,
      `PROMPT='$ '\n__aiborg_test_init() {\n  emulate -L zsh\n${getClientProfileZshRestoreSnippet()}}\n__aiborg_test_init\n# A theme rebuilds PROMPT in its own precmd first (as powerlevel10k does).\n__theme_precmd() { PROMPT='theme$ ' }\nprecmd_functions=(__theme_precmd \${precmd_functions:#__theme_precmd})\nfor f in $precmd_functions; do $f; done\nfor f in $precmd_functions; do $f; done\nprint -r -- "$GH_CONFIG_DIR|\${GITHUB_TOKEN-unset}|$PROMPT"\n`
    )
    const result = spawnSync('zsh', ['-f', script], {
      cwd: dir,
      env: profileShellEnv(dir),
      encoding: 'utf8',
      windowsHide: true
    })
    const [ghDir, token, prompt] = result.stdout.trim().split('|')
    expect(ghDir).toBe('/profile/gh')
    expect(token).toBe('unset')
    expect(prompt.match(/\[Acme touch pwned\]/g)).toHaveLength(1)
    expect(prompt).toMatch(/theme\$$/)
  })

  it.runIf(process.platform === 'win32')('PowerShell: same restore through Env:', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiborg-restore-ps-'))
    temps.push(dir)
    writePromptScript(dir)
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
      {
        cwd: dir,
        env: profileShellEnv(dir),
        input: `${getClientProfilePowerShellRestoreSnippet()}\nWrite-Output "$($env:GH_CONFIG_DIR)|$([bool]$env:GITHUB_TOKEN)|$((($env:PATH -split ';') -contains $env:AIBORG_PROFILE_BIN))"\nWrite-Output $Global:__AiborgPromptPrefix\n`,
        encoding: 'utf8',
        windowsHide: true
      }
    )
    const lines = result.stdout.trim().split(/\r?\n/)
    expect(lines).toContain('/profile/gh|False|True')
    expect(lines.some((line) => line.includes('[Acme touch pwned]'))).toBe(true)
  })

  it.runIf(process.platform === 'win32')(
    'PowerShell: the real -EncodedCommand bootstrap restores env and labels the prompt',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'aiborg-restore-ps-boot-'))
      temps.push(dir)
      writePromptScript(dir)
      const payload = `${getPowerShellOsc133Bootstrap()}\nWrite-Output "$($env:GH_CONFIG_DIR)|$([bool]$env:GITHUB_TOKEN)"\nWrite-Output (prompt)\n`
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          encodePowerShellCommand(payload)
        ],
        { cwd: dir, env: profileShellEnv(dir), encoding: 'utf8', windowsHide: true }
      )
      const lines = result.stdout.trim().split(/\r?\n/)
      expect(lines).toContain('/profile/gh|False')
      expect(lines.some((line) => line.includes('[Acme touch pwned]'))).toBe(true)
    }
  )

  it('keeps the PowerShell bootstrap well inside the Windows command-line limit', () => {
    const encodedSnippet = encodePowerShellCommand(getClientProfilePowerShellRestoreSnippet())
    // Why a budget: the bootstrap rides in every terminal's -EncodedCommand (32,767 chars max).
    expect(encodedSnippet.length).toBeLessThan(3_000)
    expect(encodePowerShellCommand(getPowerShellOsc133Bootstrap()).length).toBeLessThan(24_000)
  })
})
