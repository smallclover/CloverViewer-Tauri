param(
    [string]$MakeNsis = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe"
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$hook = Join-Path $repoRoot 'src-tauri\windows\installer-hooks.nsh'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('clover-installer-progress-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
$sourcePath = Join-Path $testRoot 'progress.nsi'
$installerPath = Join-Path $testRoot 'progress.exe'
$binaryPath = Join-Path $testRoot 'fixture.exe'
$windowPath = Join-Path $testRoot 'window.ini'
$resultPath = Join-Path $testRoot 'result.ini'

# Exercise the real native progress control in an isolated installer. The only
# file it probes is a locked text fixture; no CloverViewer installation is used.
$source = @"
Unicode true
RequestExecutionLevel user
!include LogicLib.nsh
!include FileFunc.nsh
!include "$hook"
!define MAINBINARYNAME "fixture"
Var UpdateMode
Name "Clover progress fixture"
OutFile "$installerPath"
AutoCloseWindow true
Page instfiles "" OnProgressPage
Function OnProgressPage
  WriteINIStr "$windowPath" "window" "parent" `$HWNDPARENT
FunctionEnd
Section
  StrCpy `$INSTDIR "$testRoot"
  StrCpy `$UpdateMode 1
  StrCpy `$0 "preserved-zero"
  StrCpy `$1 "preserved-one"
  StrCpy `$2 "preserved-two"
  !insertmacro NSIS_HOOK_PREINSTALL
  WriteINIStr "$resultPath" "result" "zero" `$0
  WriteINIStr "$resultPath" "result" "one" `$1
  WriteINIStr "$resultPath" "result" "two" `$2
  Sleep 500
  SetErrorLevel 0
SectionEnd
"@
[IO.File]::WriteAllText($sourcePath, $source, [Text.UTF8Encoding]::new($false))
& $MakeNsis /V2 $sourcePath
if ($LASTEXITCODE -ne 0) { throw 'NSIS progress fixture compilation failed.' }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CloverProgressFixture {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
    [DllImport("user32.dll")]
    public static extern IntPtr GetDlgItem(IntPtr parent, int id);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
}
'@

[IO.File]::WriteAllText($binaryPath, 'fixture contents')
$lock = [IO.File]::Open($binaryPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$process = $null
try {
    $process = Start-Process -FilePath $installerPath -WindowStyle Hidden -PassThru
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $windowPath)) {
        if ($process.HasExited -or $timer.Elapsed.TotalSeconds -gt 5) { throw 'Progress page did not initialize.' }
        Start-Sleep -Milliseconds 20
    }
    $window = Get-Content -LiteralPath $windowPath -Raw
    if ($window -notmatch 'parent=(\d+)') { throw 'Missing fixture window handle.' }
    $parent = [IntPtr][long]$Matches[1]
    $page = [CloverProgressFixture]::FindWindowEx($parent, [IntPtr]::Zero, '#32770', $null)
    $progress = [CloverProgressFixture]::GetDlgItem($page, 1004)
    if ($progress -eq [IntPtr]::Zero) { throw 'Missing native NSIS progress control.' }
    $samples = [Collections.Generic.List[int]]::new()
    $timer.Restart()
    while ($timer.Elapsed.TotalSeconds -lt 2) {
        if ($process.HasExited -or (Test-Path -LiteralPath $resultPath)) { throw 'Installer did not wait for the lock.' }
        $samples.Add([CloverProgressFixture]::SendMessage($progress, 0x408, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32())
        Start-Sleep -Milliseconds 20
    }
    $lock.Dispose()
    if (-not $process.WaitForExit(4000)) { throw 'Installer did not finish after releasing the lock.' }
    if ($process.ExitCode -ne 0) { throw "Fixture failed: $($process.ExitCode)" }
    $result = Get-Content -LiteralPath $resultPath -Raw
    foreach ($expected in @('zero=preserved-zero', 'one=preserved-one', 'two=preserved-two')) {
        if ($result -notmatch [regex]::Escape($expected)) { throw "Missing result: $expected" }
    }
    for ($index = 1; $index -lt $samples.Count; $index++) {
        if ($samples[$index] -lt $samples[$index - 1]) {
            throw "Native progress moved backwards while waiting: $($samples -join ', ')"
        }
    }
    Write-Output "PASS: native progress never moves backwards during $($samples.Count) locked-file samples."
    Write-Output 'PASS: installation resumes after unlocking and preserves NSIS registers.'
    Write-Output "Validation artifacts: $testRoot"
} finally {
    $lock.Dispose()
    if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
}
