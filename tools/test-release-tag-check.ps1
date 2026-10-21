# Runs only the remote-tag guard extracted from the release script. Git is mocked:
# this test never queries a server, creates tags, or pushes repository changes.
$ErrorActionPreference = 'Stop'
$source = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot '../publish-release.ps1'))
$start = $source.IndexOf('  $remoteSha = $null')
$end = $source.IndexOf('  if ($localSha', $start)
if ($start -lt 0 -or $end -le $start) { throw 'Remote-tag guard not found.' }
$guard = [scriptblock]::Create($source.Substring($start, $end - $start) + "`n" + 'return $remoteSha')
$Tag = 'v0.1.26'
$sha = 'a' * 40
function Fail($message) { throw $message }
function Invoke-Git {
  param([string[]]$Arguments)
  if (($Arguments -join '|') -ne 'ls-remote|--exit-code|--tags|origin|refs/tags/v0.1.26') {
    throw 'Unexpected Git operation in remote-tag guard.'
  }
  return $script:fixture
}
$cases = @(
  @{ Name='missing tag'; Code=2; Lines=@(); Expected=$null; Fails=$false },
  @{ Name='missing tag with SSH warning'; Code=2; Lines=@('Connection to github.com closed.'); Expected=$null; Fails=$false },
  @{ Name='valid reference after SSH warning'; Code=0; Lines=@('Connection warning', "$sha`trefs/tags/v0.1.26"); Expected=$sha; Fails=$false },
  @{ Name='network failure'; Code=128; Lines=@('Connection reset by peer'); Expected=$null; Fails=$true },
  @{ Name='warning without a valid reference'; Code=0; Lines=@('Connection warning'); Expected=$null; Fails=$true },
  @{ Name='another version is not a match'; Code=0; Lines=@("$sha`trefs/tags/v0.1.260"); Expected=$null; Fails=$true }
)
foreach ($case in $cases) {
  $script:fixture = [pscustomobject]@{ ExitCode=$case.Code; Output=$case.Lines }
  $failed = $false
  $result = $null
  try { $result = & $guard } catch { $failed = $true }
  if ($failed -ne $case.Fails -or (-not $failed -and $result -ne $case.Expected)) {
    throw ('Remote-tag guard regression: ' + $case.Name)
  }
  Write-Output ('PASS: ' + $case.Name)
}
