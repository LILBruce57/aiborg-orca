; electron-builder NSIS hooks for the AI-Borg Windows installer (replaces upstream's
; config/nsis/orca-installer-hooks.nsh via config/aiborg/builder-overrides.cjs).
;
; Why not upstream's file: AI-Borg keeps the Orca.exe image name, so upstream's uninstall
; `taskkill /IM Orca.exe` would also kill a stock Orca running side by side, its
; RMDir would delete stock Orca's %LOCALAPPDATA%\Orca\daemon-host, and its Markdown
; ProgID ("Orca.Markdown") would overwrite and then delete stock Orca's Open-with entry.
; AI-Borg therefore registers no Markdown Open-with entry on Windows.

; Running-app check, scoped to processes under $INSTDIR. Replaces upstream's
; config/nsis/orca-process-check.nsh, whose failed-probe fallback finds and kills by image name
; (Orca.exe) and so would reach a stock Orca running side by side. This one fails closed instead.
; Defining the hook suppresses electron-builder's process-info declarations.
!include "getProcessInfo.nsh"
Var pid
Var /GLOBAL IsPowerShellAvailable

!macro customCheckAppRunning
  aiborgProbeProcesses:
  nsExec::Exec `"$PowerShellPath" -Command "try { Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }"`
  Pop $0
  ${if} $0 != 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "AI-Borg setup cannot check which programs are running, so it will not close anything. Close AI-Borg yourself, then choose Retry." /SD IDCANCEL IDRETRY aiborgProbeProcesses
    Quit
  ${endIf}
  ; 0 selects electron-builder's $INSTDIR-scoped PowerShell find/kill.
  StrCpy $IsPowerShellAvailable 0
  !insertmacro _CHECK_APP_RUNNING
!macroend

; The LOCALAPPDATA folder name must match AIBORG_BRAND.daemonHostRootName
; (src/shared/aiborg/brand.ts), which daemon-host-relocation.ts copies the host into.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $0
    ; Why by path, not image name: the relocated host is a verbatim Orca.exe copy, and an
    ; image-name kill would reach stock Orca's daemon and windows too.
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$LOCALAPPDATA\AI-Borg\daemon-host\', [System.StringComparison]::OrdinalIgnoreCase) } | Invoke-CimMethod -MethodName Terminate | Out-Null"`
    Pop $0
    Pop $0
    ; Give the OS a moment to release the image lock before removing the tree.
    Sleep 500
    RMDir /r "$LOCALAPPDATA\AI-Borg\daemon-host"
  ${endIf}
!macroend
