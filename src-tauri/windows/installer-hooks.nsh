!include "${__FILEDIR__}\app-processes.nsh"

; The updater starts NSIS before exiting the old process. Give that process
; time to release its executable before Restart Manager tries to close it.
; This also works when updating from older clients without custom arguments.
; NSIS advances section progress by instruction position. Keep the retry loop
; in a function so jumping backwards does not repeatedly rewind the bar.
; Receive the path on the stack: Tauri includes hooks before declaring its
; variables and MAINBINARYNAME, so they cannot be referenced here yet.
Function CloverWaitForExecutableUnlock
  Exch $0
  Push $1
  Push $2
  StrCpy $1 40

clover_wait_retry:
  IfFileExists "$0" 0 clover_wait_done
  ; OPEN_EXISTING avoids creating a file. Request write access without writing
  ; any bytes; an executable mapped by a running process denies this access.
  System::Call 'kernel32::CreateFileW(w r0, i 0x40000000, i 7, p 0, i 3, i 0, p 0) p .r2'
  StrCmp $2 -1 clover_wait_locked
  System::Call 'kernel32::CloseHandle(p r2)'
  Goto clover_wait_done

clover_wait_locked:
  IntOp $1 $1 - 1
  IntCmp $1 0 clover_wait_done
  Sleep 250
  Goto clover_wait_retry

clover_wait_done:
  ; Persistent locks still go through Tauri's existing Restart Manager check.
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  StrCmp $UpdateMode 1 0 clover_wait_skip
  Push "$INSTDIR\${MAINBINARYNAME}.exe"
  Call CloverWaitForExecutableUnlock
clover_wait_skip:
!macroend
