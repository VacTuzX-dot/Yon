; Yon NSIS hooks: add "Send to → Yon" to Explorer's context menu, and remove
; the login entry on uninstall.
; Explorer runs `yon.exe <files…>`; the running instance receives them via
; the single-instance plugin and asks which device to send to.

!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$APPDATA\Microsoft\Windows\SendTo\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$APPDATA\Microsoft\Windows\SendTo\${PRODUCTNAME}.lnk"
  ; "Open Yon when I log in" (Settings) lives in this value; don't leave it behind.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
!macroend
