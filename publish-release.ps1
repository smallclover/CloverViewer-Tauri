<#
.SYNOPSIS
一键发布 CloverViewer：给当前 HEAD 打版本标签并推送 main 与标签，
构建 NSIS 安装包 + 创建 GitHub Release 由 .github/workflows/release.yml 自动完成。

.DESCRIPTION
安全约束（针对「误发版本 / 覆盖历史标签」这类事故）：
- -Tag 必填：不再默认复用 v0.1.0，避免忘了传参就把已在线的历史标签强推覆盖。
- 标签必须与清单版本一致：-Tag 必须等于 v<package.json 的 version>。
- package.json / tauri.conf.json / Cargo.toml（[package].version）三处版本号必须一致，
  Cargo.lock 里的 cloverviewer-tauri 版本不一致只告警（cargo 构建时会自动更新）。
- 同名标签已存在且指向其他提交时，默认直接报错退出；确需移动请显式加 -MoveExistingTag。
- 发布前自动运行 scripts/release-check.mjs（完整流程见 docs/release.md）：CHANGELOG 必须已有
  `## v<版本>` 段落，三语 README、介绍页与 sitemap 必须一致；有阻塞项即退出。
- 推送顺序为「先 main 后标签」，标签始终落在已推送到远端的提交上。
- -PruneTags：发布成功后清理除当前版本以外的本地与远端标签（会先列清单并要求输入 yes 确认）。
  注意：清理标签不会删除 GitHub Release —— Release 只能在网页或 API 里删除。

.EXAMPLE
  ./publish-release.ps1 -Tag v0.1.0
  发布 v0.1.0（要求三处清单版本均为 0.1.0）。

.EXAMPLE
  ./publish-release.ps1 -Tag v0.1.4 -PruneTags
  发布 v0.1.4，并在成功后清理其它本地/远端标签。

.NOTES
- 本地不需要 GitHub Token；Actions 使用自带的 GITHUB_TOKEN。
- 需要 git 已配置对 origin 的推送权限（SSH key 或 credential helper）。
- 本文件必须以 UTF-8 with BOM 保存：Windows PowerShell 5.1 会按 ANSI/GBK 读取无 BOM
  文件，中文注释会被解析坏（历史上踩过一次）。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, HelpMessage = '要发布的标签，必须等于 v<清单版本>，例如 v0.1.0')]
  [string]$Tag,

  [switch]$MoveExistingTag,

  [switch]$PruneTags
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
$Repo = 'smallclover/CloverViewer-Tauri'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "警告：$msg" -ForegroundColor Yellow }

# git 会把正常提示写到 stderr（例如 main 已是最新时的 "Everything up-to-date"）。
# 当 PowerShell 的 stderr 被重定向（AI / CI / 管道场景）时，这些行会被包装成
# ErrorRecord；配合下面的 $ErrorActionPreference = 'Stop'，脚本会在完全正常的位置
# 中止（v0.1.10 发布时真实踩到，表现为推送 main 后直接退出、标签未推）。
# 因此所有 git 调用统一走 Invoke-Git：stderr 也按普通文本捕获，返回退出码，
# 由调用点显式判断成败，交互与非交互环境下行为一致。
function Invoke-Git {
  param([string[]]$Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $captured = & git @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $lines = @(
    foreach ($item in @($captured)) {
      if ($item -is [System.Management.Automation.ErrorRecord]) { $item.ToString() }
      else { [string]$item }
    }
  )
  return [pscustomobject]@{ ExitCode = $code; Output = $lines }
}

Push-Location $RepoRoot
try {
  # ---- 1. 标签格式 ----
  if ($Tag -notmatch '^v\d+\.\d+\.\d+$') {
    Fail "标签格式不合法：$Tag（应形如 v0.1.0）"
  }

  # ---- 2. 三处清单版本必须一致，且与标签匹配 ----
  $pkgVersion = (Get-Content -Raw -Encoding UTF8 package.json | ConvertFrom-Json).version
  $confVersionRaw = (Get-Content -Raw -Encoding UTF8 src-tauri/tauri.conf.json | ConvertFrom-Json).version
  # Tauri 支持从 package.json 读取版本号；此时清单中的路径与包版本等价，
  # 不应被误判为版本不一致。
  $confVersion = if ($confVersionRaw -eq '../package.json') { $pkgVersion } else { $confVersionRaw }
  $cargoLine = Select-String -Path src-tauri/Cargo.toml -Pattern '^\s*version\s*=\s*"([^"]+)"' |
    Select-Object -First 1
  if (-not $cargoLine) { Fail 'src-tauri/Cargo.toml 里找不到 [package] 的 version。' }
  $cargoVersion = $cargoLine.Matches[0].Groups[1].Value

  if ($pkgVersion -ne $confVersion -or $pkgVersion -ne $cargoVersion) {
    Fail @"
版本号不一致，先统一再发布：
  package.json              = $pkgVersion
  src-tauri/tauri.conf.json = $confVersionRaw
  src-tauri/Cargo.toml      = $cargoVersion
"@
  }

  $expectedTag = "v$pkgVersion"
  if ($Tag -ne $expectedTag) {
    Fail "标签与清单版本不匹配：-Tag $Tag，但三处清单版本都是 $pkgVersion（应为 $expectedTag）。"
  }

  $lockMatch = [regex]::Match(
    (Get-Content -Raw -Encoding UTF8 src-tauri/Cargo.lock),
    'name\s*=\s*"cloverviewer-tauri"\s*\r?\nversion\s*=\s*"([^"]+)"')
  if ($lockMatch.Success -and $lockMatch.Groups[1].Value -ne $pkgVersion) {
    Warn "Cargo.lock 里 cloverviewer-tauri 仍是 $($lockMatch.Groups[1].Value)，与 $pkgVersion 不一致（cargo 构建时会自行更新）。"
  }

  # ---- 2.5 发版前机械预检 ----
  # CHANGELOG 版本段落、三语 README 同步、介绍页与 sitemap 一致性等
  # 由脚本统一校验（只读，不改文件）。这里只负责在出现阻塞项时中止发布。
  # 完整发布流程与人工项见 docs/release.md。
  Step '运行发版前机械预检（scripts/release-check.mjs）...'
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail '找不到 node 命令，无法运行发版前预检（需要 Node.js 在 PATH 中）。'
  }
  node scripts/release-check.mjs
  if ($LASTEXITCODE -ne 0) {
    Fail '发版前预检未通过（见上方 [FAIL] 项），先修掉再发布。'
  }

  # ---- 3. 工作区必须干净 ----
  $status = Invoke-Git @('status', '--porcelain')
  if ($status.ExitCode -ne 0) { Fail 'git status 执行失败，请确认当前目录是仓库根目录。' }
  $porcelain = @($status.Output)
  if ($porcelain.Count -gt 0) {
    Write-Host '工作区还有未提交/未跟踪的改动，先 commit 或 stash 再发布：' -ForegroundColor Yellow
    $porcelain | ForEach-Object { Write-Host "  $_" }
    Fail 'Working tree is not clean.'
  }

  # ---- 4. 远端可达 ----
  Step '检查远端 origin ...'
  $probe = Invoke-Git @('ls-remote', '--exit-code', 'origin', 'HEAD')
  if ($probe.ExitCode -ne 0) { Fail '无法访问远端 origin，请检查网络 / SSH 凭据。' }

  $headSha = @((Invoke-Git @('rev-parse', 'HEAD')).Output)[0]
  if (-not $headSha) { Fail '无法读取 HEAD，请确认当前目录是 git 仓库。' }
  $headSha = $headSha.Trim()
  $headShort = @((Invoke-Git @('rev-parse', '--short', 'HEAD')).Output)[0].Trim()
  Step "当前 HEAD：$headShort（清单版本 $pkgVersion）"

  # ---- 5. 本地 / 远端同名标签的现状 ----
  $localSha = $null
  $showRef = Invoke-Git @('show-ref', '--verify', '--quiet', "refs/tags/$Tag")
  if ($showRef.ExitCode -eq 0) {
    $localSha = @((Invoke-Git @('rev-list', '-n', '1', $Tag)).Output)[0].Trim()
  }

  $remoteSha = $null
  foreach ($line in (Invoke-Git @('ls-remote', '--tags', 'origin', "refs/tags/$Tag")).Output) {
    if ($line -and $line -notmatch '\^\{\}') {
      $remoteSha = ($line -split '\s+')[0]
      break
    }
  }

  if ($localSha -and $localSha -ne $headSha -and -not $MoveExistingTag) {
    Fail "本地标签 $Tag 已存在且指向 $($localSha.Substring(0, 7))，不是当前 HEAD。确需把它移到 HEAD 请加 -MoveExistingTag。"
  }
  if ($remoteSha -and $remoteSha -ne $headSha -and -not $MoveExistingTag) {
    Fail "远端标签 $Tag 已存在且指向 $($remoteSha.Substring(0, 7))，不是当前 HEAD。确需覆盖已发布标签请加 -MoveExistingTag。"
  }

  # ---- 6. 本地打标签（必要时移动）----
  if ($localSha -eq $headSha) {
    Step "本地标签 $Tag 已指向 HEAD，保持不动"
  } else {
    Step "创建本地标签 $Tag -> $headShort"
    $tagResult = Invoke-Git @('tag', '-f', $Tag, 'HEAD')
    if ($tagResult.ExitCode -ne 0) { Fail '本地打标签失败。' }
  }

  # ---- 7. 先推 main，再推标签 ----
  Step '推送 main ...'
  $pushMain = Invoke-Git @('push', 'origin', 'main')
  $pushMain.Output | ForEach-Object { Write-Host "    $_" }
  if ($pushMain.ExitCode -ne 0) { Fail '推送 main 失败（远端是否领先于本地？）。' }

  if ($remoteSha -eq $headSha) {
    Step "远端标签 $Tag 已在当前提交上，跳过推送"
  } elseif ($remoteSha) {
    Step "强推标签 $Tag：$($remoteSha.Substring(0, 7)) -> $headShort"
    $pushTag = Invoke-Git @('push', '--force', 'origin', "refs/tags/$Tag")
    $pushTag.Output | ForEach-Object { Write-Host "    $_" }
    if ($pushTag.ExitCode -ne 0) { Fail '推送标签失败。' }
  } else {
    Step "推送标签 $Tag ..."
    $pushTag = Invoke-Git @('push', 'origin', "refs/tags/$Tag")
    $pushTag.Output | ForEach-Object { Write-Host "    $_" }
    if ($pushTag.ExitCode -ne 0) { Fail '推送标签失败。' }
  }

  # ---- 8. 可选：清理其余标签 ----
  if ($PruneTags) {
    Step '收集除当前版本以外的标签 ...'
    $localTags = @((Invoke-Git @('tag', '-l')).Output | Where-Object { $_ -and $_ -ne $Tag })
    $remoteTags = @()
    foreach ($line in (Invoke-Git @('ls-remote', '--tags', 'origin')).Output) {
      if ($line -match 'refs/tags/(.+)$') {
        $name = $Matches[1]
        if ($name -notmatch '\^\{\}$' -and $name -ne $Tag) { $remoteTags += $name }
      }
    }

    $stale = @()
    $stale += $localTags | ForEach-Object { "本地  $_" }
    $stale += $remoteTags | ForEach-Object { "远端  $_" }

    if ($stale.Count -eq 0) {
      Write-Host '没有需要清理的标签。'
    } else {
      Write-Host '以下标签将被删除（对应的 GitHub Release 不受影响，只能在网页/API 删除）：' -ForegroundColor Yellow
      $stale | ForEach-Object { Write-Host "  $_" }
      $answer = Read-Host "确认删除这 $($stale.Count) 个标签？输入 yes 继续"
      if ($answer -ne 'yes') {
        Warn '已跳过标签清理。'
      } else {
        foreach ($t in $localTags) {
          $null = Invoke-Git @('tag', '-d', $t)
        }
        if ($remoteTags.Count -gt 0) {
          $deleteTags = Invoke-Git (@('push', 'origin', '--delete') + $remoteTags)
          if ($deleteTags.ExitCode -ne 0) { Warn '部分远端标签删除失败，请检查上面输出。' }
        }
        Write-Host '标签清理完成。'
      }
    }
  }

  Write-Host ''
  Write-Host "✔ 已推送 $Tag 与 main（HEAD = $headShort）。" -ForegroundColor Green
  Write-Host 'GitHub Actions 现在会自动构建并创建 Release（约几分钟）。'
  Write-Host "查看进度: https://github.com/$Repo/actions"
  Write-Host "发布结果: https://github.com/$Repo/releases/tag/$Tag"
} finally {
  Pop-Location
}
