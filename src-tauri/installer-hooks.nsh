; Scorch NSIS installer hooks (Stage 3f-1 — fresh install must start empty).
;
; Wired via bundle.windows.nsis.installerHooks in tauri.conf.json. Tauri's
; generated installer.nsi !defines the NSIS_HOOK_* macros it finds in this
; file and !insertmacro's them at the matching lifecycle points (verified
; against tauri-bundler 2.9.x: NSIS_HOOK_POSTUNINSTALL runs at the tail of
; the uninstall section).
;
; WHY: the app's saved data survives uninstall because it lives OUTSIDE the
; install directory:
;   * %LOCALAPPDATA%\com.scorch.app — WebView2 user-data folder, including
;     the localStorage autosave key and the mix key from
;     src/state/persistence.ts ("scorch.autosave.v1" / "scorch.mix.v1");
;   * %APPDATA%\scorch — engine.log, error.log and any engine data.
; A user who uninstalls to get a CLEAN slate must get one: both folders are
; deleted recursively here. %APPDATA%\VST3 and every other plugin folder are
; NEVER touched — a reinstall must still find the user's sample libraries
; and plugins.
;
; UPDATE SAFETY: the uninstall step of an upgrade/update must NOT wipe the
; saved data the update is meant to preserve. Tauri's NSIS template runs the
; uninstaller in update mode with $UpdateMode = 1 (set from /UPDATE, which
; tauri-plugin-updater passes), so the deletion is guarded.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode != 1
    DetailPrint "Scorch: removing saved app data (fresh-install hygiene)"
    RMDir /r "$LOCALAPPDATA\com.scorch.app"
    RMDir /r "$APPDATA\scorch"
  ${Else}
    DetailPrint "Scorch: update install — saved app data preserved"
  ${EndIf}
!macroend
