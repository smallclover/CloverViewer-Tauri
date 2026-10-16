param(
    [string]$MakeNsis = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe",
    [string]$TauriUtils = "$PSScriptRoot\..\src-tauri\target\release\nsis\x64\utils.nsh"
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$hook = Join-Path $repoRoot 'src-tauri\windows\installer-hooks.nsh'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('clover-installer-processes-' + [guid]::NewGuid())
$appRoot = Join-Path $testRoot (([string][char]0x5E94) + [char]0x7528 + ' with spaces')
$otherRoot = Join-Path $testRoot 'other'
New-Item -ItemType Directory -Path $appRoot, $otherRoot | Out-Null
$appPath = Join-Path $appRoot 'fixture.exe'
$otherPath = Join-Path $otherRoot 'fixture.exe'
$checkerPath = Join-Path $testRoot 'checker.exe'
$sourcePath = Join-Path $testRoot 'fixture.nsi'
$resultPath = Join-Path $testRoot 'result.ini'
$plugins = Join-Path (Split-Path $MakeNsis -Parent) 'Plugins\x86-unicode\additional'

function Compile-Fixture([string]$Source) {
    [IO.File]::WriteAllText($sourcePath, $Source, [Text.UTF8Encoding]::new($true))
    & $MakeNsis /V2 $sourcePath
    if ($LASTEXITCODE -ne 0) { throw 'NSIS fixture compilation failed.' }
}

Compile-Fixture @"
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "$appPath"
Section
  Sleep 60000
SectionEnd
"@
Copy-Item -LiteralPath $appPath -Destination $otherPath

Compile-Fixture @"
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!include MUI2.nsh
!include FileFunc.nsh
!include Win\RestartManager.nsh
!include "$TauriUtils"
!include "$hook"
!addplugindir "$plugins"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
LangString appRunning `${LANG_ENGLISH} "{{product_name}} is running."
LangString appRunningOkKill `${LANG_ENGLISH} "Close {{product_name}}?"
LangString failedToKillApp `${LANG_ENGLISH} "Cannot close {{product_name}}."
!define MAINBINARYNAME "fixture"
Var UpdateMode
Var PassiveMode
OutFile "$checkerPath"
!macro VerifyProcesses sectionName
  StrCpy `$INSTDIR "$appRoot"
  StrCpy `$UpdateMode 0
  StrCpy `$PassiveMode 1
  ClearErrors
  `${GetOptions} `$CMDLINE "/LEGACY" `$0
  StrCpy `$4 0
  `${IfNot} `${Errors}
    StrCpy `$4 1
  `${EndIf}
  StrCpy `$R1 "preserved-one"
  StrCpy `$R2 "preserved-two"
  StrCpy `$R8 "preserved-eight"
  StrCpy `$R9 "preserved-nine"
  !insertmacro RestartManager_StartSession `$R0
  StrCmp `$R0 "" 0 +3
    SetErrorLevel 10
    Quit
  `${If} `$4 = 1
    System::Call 'rstrtmgr::RmRegisterResources(i R0, i 1, *w "$appPath", i 0, p 0, i 0, p 0) i .r0'
  `${Else}
    !insertmacro CloverRegisterAppProcesses `$R0 "$appPath"
  `${EndIf}
  WriteINIStr "$resultPath" "`${sectionName}" "registration" `$0
  StrCpy `$1 0
  StrCpy `$2 0
  System::Call 'rstrtmgr::RmGetList(i R0, *i .r1, *i .r2, p 0, *i .r3) i .r0'
  WriteINIStr "$resultPath" "`${sectionName}" "status" `$0
  WriteINIStr "$resultPath" "`${sectionName}" "count" `$1
  WriteINIStr "$resultPath" "`${sectionName}" "one" `$R1
  WriteINIStr "$resultPath" "`${sectionName}" "two" `$R2
  WriteINIStr "$resultPath" "`${sectionName}" "eight" `$R8
  WriteINIStr "$resultPath" "`${sectionName}" "nine" `$R9
  !insertmacro RestartManager_EndSession `$R0
  ClearErrors
  `${GetOptions} `$CMDLINE "/CHECK" `$0
  `${IfNot} `${Errors}
    !insertmacro CheckIfAppIsRunning "$appPath" "Clover fixture"
  `${EndIf}
  WriteINIStr "$resultPath" "`${sectionName}" "finished" "yes"
  SetErrorLevel 0
!macroend
Section
  WriteUninstaller "$testRoot\uninstall.exe"
  !insertmacro VerifyProcesses "install"
SectionEnd
Section Uninstall
  !insertmacro VerifyProcesses "uninstall"
SectionEnd
"@

function Assert-Processes([int]$ExpectedCount, [bool]$CheckUninstall = $false, [bool]$Legacy = $false, [bool]$CloseApp = $false) {
    $fixturePath = if ($CheckUninstall) { Join-Path $testRoot 'uninstall.exe' } else { $checkerPath }
    $arguments = if ($ExpectedCount -eq 0) { '/S /CHECK' } else { '/S' }
    if ($Legacy) { $arguments += ' /LEGACY' }
    if ($CloseApp) { $arguments += ' /CHECK' }
    if ($CheckUninstall) { $arguments += " _?=$testRoot" }
    $process = Start-Process -FilePath $fixturePath -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $timeout = if ($CloseApp) { 45000 } else { 10000 }
    if (-not $process.WaitForExit($timeout)) {
        $process.Kill()
        throw "Process check exceeded $timeout milliseconds."
    }
    if ($process.ExitCode -ne 0) { throw "Process check failed: $($process.ExitCode)" }
    $result = Get-Content -LiteralPath $resultPath -Raw
    $expectedStatus = if ($ExpectedCount -eq 0) { 0 } else { 234 }
    foreach ($expected in @('registration=0', "status=$expectedStatus", "count=$ExpectedCount", 'one=preserved-one', 'two=preserved-two', 'eight=preserved-eight', 'nine=preserved-nine', 'finished=yes')) {
        if ($result -notmatch "(?m)^$([regex]::Escape($expected))\r?$") { throw "Missing result: $expected" }
    }
    Remove-Item -LiteralPath $resultPath
}

Assert-Processes 0
Assert-Processes 0 $true
Write-Output 'PASS: installation and standalone uninstallation allow a stopped app.'

$otherProcess = Start-Process -FilePath $otherPath -WindowStyle Hidden -PassThru
try {
    Assert-Processes 0
    $lock = [IO.File]::Open($appPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        Assert-Processes 1 $false $true
        Write-Output 'PASS: the original file registration reproduces the false running-app detection.'
        Assert-Processes 0
        Assert-Processes 0 $true
        if ($otherProcess.HasExited) { throw 'A process outside the installation was stopped.' }
        Write-Output 'PASS: external file locks and another copy with the same name are not treated as the app.'
    } finally { $lock.Dispose() }

    $appProcess = Start-Process -FilePath $appPath -WindowStyle Hidden -PassThru
    try {
        Assert-Processes 1
        Assert-Processes 1 $true
        if ($appProcess.HasExited) { throw 'Registration unexpectedly stopped the app.' }
        Write-Output 'PASS: the actual app is registered by path for both installation and uninstallation.'
        Assert-Processes 1 $false $false $true
        if (-not $appProcess.WaitForExit(3000)) { throw 'The actual app was not closed.' }
        if ($otherProcess.HasExited) { throw 'Closing the app stopped a different installation.' }
        Write-Output 'PASS: the original shutdown check still closes only the actual app.'
    } finally {
        if (-not $appProcess.HasExited) { $appProcess.Kill(); $appProcess.WaitForExit() }
    }
} finally {
    if (-not $otherProcess.HasExited) { $otherProcess.Kill(); $otherProcess.WaitForExit() }
}

Write-Output "Validation artifacts: $testRoot"
