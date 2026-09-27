; Yon NSIS hooks: add "Send to → Yon" to Explorer's context menu.
; Explorer runs `yon.exe <files…>`; the running instance receives them via
; the single-instance plugin and asks which device to send to.

!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$APPDATA\Microsoft\Windows\SendTo\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$APPDATA\Microsoft\Windows\SendTo\${PRODUCTNAME}.lnk"
!macroend
