!macro CloverRegisterAppProcesses session executablePath
  System::Store "s"
  StrCpy $R8 "${session}"
  GetFullPathName $R9 "${executablePath}"
  ${GetFileName} "$R9" $R6
  StrCpy $R7 0
  StrCpy $1 0
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p .r2 ?e'
  Pop $0
  ${If} $2 = -1
    StrCpy $R7 $0
  ${Else}
    System::Alloc 556
    Pop $1
    ${If} $1 = 0
      StrCpy $R7 8
    ${Else}
      System::Call '*$1(i 556)'
      System::Call 'kernel32::Process32FirstW(p r2, p r1) i .r3 ?e'
      Pop $9
      ${While} $3 <> 0
        System::Call '*$1(i, i, i .r6, p, i, i, i, i, i, &w260 .r5)'
        ${If} $5 == $R6
          System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r6) p .r4 ?e'
          Pop $0
          ${If} $4 <> 0
            System::Call 'kernel32::QueryFullProcessImageNameW(p r4, i 0, w .r5, *i ${NSIS_MAX_STRLEN}) i .r0 ?e'
            Pop $8
            ${If} $0 <> 0
              GetFullPathName $5 "$5"
              ${If} $5 == $R9
                System::Alloc 32
                Pop $7
                ${If} $7 = 0
                  StrCpy $R7 8
                ${Else}
                  IntOp $8 $7 + 8
                  IntOp $9 $7 + 16
                  IntOp $0 $7 + 24
                  System::Call 'kernel32::GetProcessTimes(p r4, p r7, p r8, p r9, p r0) i .r0 ?e'
                  Pop $5
                  ${If} $0 <> 0
                    System::Call '*$7(i .r8, i .r9)'
                    System::Call '*(i r6, i r8, i r9) p .r8'
                    ${If} $8 = 0
                      StrCpy $R7 8
                    ${Else}
                      System::Call 'rstrtmgr::RmRegisterResources(i R8, i 0, p 0, i 1, p r8, i 0, p 0) i .R7'
                      System::Free $8
                    ${EndIf}
                  ${Else}
                    StrCpy $R7 $5
                  ${EndIf}
                  System::Free $7
                ${EndIf}
              ${EndIf}
            ${Else}
              StrCpy $R7 $8
            ${EndIf}
            System::Call 'kernel32::CloseHandle(p r4)'
          ${Else}
            StrCpy $R7 $0
            ${If} $R7 = 87
              StrCpy $R7 0
            ${EndIf}
          ${EndIf}
        ${EndIf}
        ${If} $R7 <> 0
          ${Break}
        ${EndIf}
        System::Call 'kernel32::Process32NextW(p r2, p r1) i .r3 ?e'
        Pop $9
      ${EndWhile}
      ${If} $R7 = 0
        ${If} $9 <> 18
          StrCpy $R7 $9
        ${EndIf}
      ${EndIf}
    ${EndIf}
    System::Free $1
    System::Call 'kernel32::CloseHandle(p r2)'
  ${EndIf}
  Push $R7
  System::Store "l"
  Pop $0
!macroend

!ifmacrodef RestartManager_RegisterFile
  !macroundef RestartManager_RegisterFile
  !macro RestartManager_RegisterFile session executablePath
    !insertmacro CloverRegisterAppProcesses "${session}" "${executablePath}"
    ${If} $0 <> 0
      !insertmacro RestartManager_EndSession "${session}"
      Abort $R3
    ${EndIf}
  !macroend
!endif
