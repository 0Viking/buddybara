; Uninstall hooks for the NSIS installer.
;
; The inbox and the log live in %LOCALAPPDATA%\Buddybara: the installer never
; recorded them, so the default uninstaller would leave them behind.
;
; Claude Code's own settings.json is deliberately NOT touched here: it belongs to
; the user, it may contain hooks from other tools, and rewriting somebody's
; config from an uninstaller with no diff and no consent is exactly what the rest
; of this app goes out of its way not to do. So the relay its hooks run stays
; too (%LOCALAPPDATA%\Buddybara\bin): with the app gone it exits at once and
; Claude Code goes on, where a missing one would be a hook error on every event.
; Settings → Claude Code removes the hooks, with a diff, before uninstalling.

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\Buddybara\inbox"
  Delete "$LOCALAPPDATA\Buddybara\buddybara.log"
!macroend
