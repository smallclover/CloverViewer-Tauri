# 滚动截图 P0 探针用的「确定可滚动」目标窗口。
#
# 为什么需要它：真实应用（浏览器 / 资源管理器）受环境、渲染方式、沙箱等多种因素影响，
# 出问题时无法区分「是我注入的方式不对」还是「这个应用不吃这种方式」。这个脚本用
# WinForms 造一个**几何完全已知**的 ListBox（2000 行 + 标准滚动条），用来先验证：
#   - 区域捕获帧是否随滚动正确变化
#   - WM_VSCROLL / WM_MOUSEWHEEL(Post) / SendInput 三种注入哪些真的能滚
#   - GetScrollInfo(SB_VERT) 的 pos 是否随注入精确变化（最硬的证据）
#
# 用法：pwsh -File tools/scroll-probe/winforms-target.ps1 [-Items 2000]
param(
  [int]$Items = 2000,
  [int]$X = 120,
  [int]$Y = 120,
  [int]$W = 900,
  [int]$H = 700
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "cloverprobe-winforms-target"
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.ClientSize = New-Object System.Drawing.Size($W, $H)
$form.MinimumSize = New-Object System.Drawing.Size(400, 300)

$list = New-Object System.Windows.Forms.ListBox
$list.Dock = "Fill"
$list.Font = New-Object System.Drawing.Font("Consolas", 14)
$list.IntegralHeight = $false
$list.Items.Clear()
for ($i = 1; $i -le $Items; $i++) {
  [void]$list.Items.Add(("cloverprobe item {0:D4} :: 滚动截图验证 0123456789 abcdefghij" -f $i))
}
$form.Controls.Add($list)

$form.Add_Shown({
    $list.Focus() | Out-Null
    $form.Activate()
  })

[void]$form.Show()
$form.Activate()
[System.Windows.Forms.Application]::Run($form)
