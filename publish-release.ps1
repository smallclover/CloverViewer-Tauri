<#
.SYNOPSIS
一键发布 CloverViewer：把 v0.1.0 标签挪到当前 HEAD，推送 main 和标签，
剩下的（构建 NSIS 安装包 + 创建 GitHub Release）由 .github/workflows/release.yml 自动完成。

.DESCRIPTION
- 本地不需要 GitHub Token；Actions 使用自带的 GITHUB_TOKEN。
- 需要 git 已配置对 origin 的推送权限（SSH key 或 credential helper）。
- 默认复用 v0.1.0 标签（会强推覆盖该标签到 HEAD）。

.EXAMPLE
  ./publish-release.ps1              # 使用默认标签 v0.1.0
  ./publish-release.ps1 -Tag v0.2.0  # 换用其他标签
#>
param(
  [string]$Tag = "v0.1.0"
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot
$Repo = "smallclover/CloverViewer-Tauri"

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

Push-Location $RepoRoot
try {
  # 1. 确保工作区干净（发布内容必须已提交）
  $porcelain = git status --porcelain 2>&1
  if ($porcelain) {
    Write-Host "工作区还有未提交/未跟踪的改动，先在本地 commit 后再发布：" -ForegroundColor Yellow
    git status --porcelain
    Fail "Working tree is not clean."
  }

  # 2. 确认远端能访问
  git ls-remote --exit-code origin > $null 2>&1
  if ($LASTEXITCODE -ne 0) {
    Fail "无法访问远端 origin，请检查网络 / SSH 凭据。"
  }

  # 3. 把标签挪到当前 HEAD（复用已有版本号）
  Write-Host "移动标签 $Tag -> HEAD ($(git rev-parse --short HEAD))"
  git tag -f $Tag HEAD
  if ($LASTEXITCODE -ne 0) { Fail "本地打标签失败。" }

  # 4. 推送 main 与标签
  Write-Host "推送 main ..."
  git push origin main
  if ($LASTEXITCODE -ne 0) { Fail "推送 main 失败。" }

  Write-Host "强推标签 $Tag ..."
  git push --force origin $Tag
  if ($LASTEXITCODE -ne 0) { Fail "推送标签失败。" }

  Write-Host ""
  Write-Host "✔ 已推送 $Tag 和 main。" -ForegroundColor Green
  Write-Host "GitHub Actions 现在会自动构建并创建 Release（约几分钟）。"
  Write-Host "查看进度: https://github.com/$Repo/actions"
  Write-Host "发布结果: https://github.com/$Repo/releases/tag/$Tag"
} finally {
  Pop-Location
}
