param(
    [string]$MakeNsis = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe"
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$hook = Join-Path $repoRoot 'src-tauri\windows\installer-hooks.nsh'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('clover-installer-wait-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
$sourcePath = Join-Path $testRoot 'wait.nsi'
$installerPath = Join-Path $testRoot 'wait.exe'
$binaryPath = Join-Path $testRoot 'fixture.exe'
$resultPath = Join-Path $testRoot 'result.ini'

# Compile the production hook into an isolated installer. It touches no app
# installation, registry entries or running CloverViewer processes.
$source = @"
Unicode true
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!include FileFunc.nsh
!include "$hook"
!define MAINBINARYNAME "fixture"
Var UpdateMode
OutFile "$installerPath"
Section
  StrCpy `$INSTDIR "$testRoot"
  StrCpy `$UpdateMode 0
  ClearErrors
  `${GetOptions} `$CMDLINE "/UPDATE" `$0
  IfErrors +2
    StrCpy `$UpdateMode 1
  StrCpy `$0 "preserved-zero"
  StrCpy `$1 "preserved-one"
  !insertmacro NSIS_HOOK_PREINSTALL
  WriteINIStr "$resultPath" "result" "zero" `$0
  WriteINIStr "$resultPath" "result" "one" `$1
  SetErrorLevel 0
SectionEnd
"@
[IO.File]::WriteAllText($sourcePath, $source, [Text.UTF8Encoding]::new($false))
& $MakeNsis /V2 $sourcePath
if ($LASTEXITCODE -ne 0) { throw 'NSIS fixture compilation failed.' }

function Start-Fixture([bool]$Update) {
    if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath }
    $arguments = if ($Update) { '/S /UPDATE' } else { '/S' }
    Start-Process -FilePath $installerPath -ArgumentList $arguments -WindowStyle Hidden -PassThru
}

function Assert-Result($Process) {
    if ($Process.ExitCode -ne 0) { throw "Fixture failed: $($Process.ExitCode)" }
    $result = Get-Content -LiteralPath $resultPath -Raw
    if ($result -notmatch 'zero=preserved-zero' -or $result -notmatch 'one=preserved-one') {
        throw 'The installer hook did not preserve NSIS registers.'
    }
}

foreach ($withFile in @($false, $true)) {
    if ($withFile) { [IO.File]::WriteAllText($binaryPath, 'fixture contents') }
    $process = Start-Fixture $true
    if (-not $process.WaitForExit(3000)) { throw 'Missing/unlocked executable unnecessarily waited.' }
    Assert-Result $process
}
Write-Output 'PASS: missing and unlocked executables return immediately.'

$lock = [IO.File]::Open($binaryPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $process = Start-Fixture $true
    if ($process.WaitForExit(1500)) { throw 'Update did not wait for the executable lock.' }
    $lock.Dispose()
    if (-not $process.WaitForExit(3000)) { throw 'Update did not resume after releasing the lock.' }
    Assert-Result $process
} finally { $lock.Dispose() }
Write-Output 'PASS: update waits for a lock and resumes when it is released.'

$lock = [IO.File]::Open($binaryPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $process = Start-Fixture $false
    if (-not $process.WaitForExit(3000)) { throw 'Manual installation unexpectedly waited.' }
    Assert-Result $process
    Write-Output 'PASS: manual installation skips the updater wait.'

    $timer = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-Fixture $true
    if (-not $process.WaitForExit(13000)) { throw 'Persistent lock exceeded the wait limit.' }
    Assert-Result $process
    if ($timer.Elapsed.TotalSeconds -lt 9 -or $timer.Elapsed.TotalSeconds -gt 13) {
        throw "Unexpected timeout: $($timer.Elapsed.TotalSeconds) seconds."
    }
    if ([IO.File]::ReadAllText($binaryPath) -ne 'fixture contents') { throw 'Executable content changed.' }
    Write-Output 'PASS: persistent lock times out in about 10 seconds without changing the executable.'
} finally { $lock.Dispose() }

Write-Output "Validation artifacts: $testRoot"
