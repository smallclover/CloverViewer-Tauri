!include "${__FILEDIR__}\app-processes.nsh"

; The updater starts NSIS before exiting the old process. Give that process
; time to release its executable before Restart Manager tries to close it.
; This also works when updating from older clients without custom arguments.
!macro NSIS_HOOK_PREINSTALL
  ; Keep this inline: Tauri includes hooks before declaring its variables and
  ; MAINBINARYNAME, so those references must resolve at macro insertion time.
  Push $0
  Push $1
  StrCmp $UpdateMode 1 0 clover_wait_done
  StrCpy $1 40

clover_wait_retry:
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 clover_wait_done
  ; OPEN_EXISTING avoids creating a file. Request write access without writing
  ; any bytes; an executable mapped by a running process denies this access.
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\${MAINBINARYNAME}.exe", i 0x40000000, i 7, p 0, i 3, i 0, p 0) p .r0'
  StrCmp $0 -1 clover_wait_locked
  System::Call 'kernel32::CloseHandle(p r0)'
  Goto clover_wait_done

clover_wait_locked:
  IntOp $1 $1 - 1
  IntCmp $1 0 clover_wait_done
  Sleep 250
  Goto clover_wait_retry

clover_wait_done:
  ; Persistent locks still go through Tauri's existing Restart Manager check.
  Pop $1
  Pop $0
!macroend
