<div align="center">
  <img src="public/logo.png" width="120" alt="CloverViewer —— 开源 Windows 图片查看器与截图工具">
  <h1>CloverViewer-Tauri —— 开源 Windows 图片查看器与截图工具（Tauri 2）</h1>
  <p>
    <b>中文</b> · <a href="README.en.md">English</a> · <a href="README.ja.md">日本語</a>
  </p>
  <p>
    一款免费、轻量的 Windows 应用，集图片浏览与截图标注于一体 —— 基于 <a href="https://tauri.app">Tauri 2</a> 对原版 <a href="https://github.com/smallclover/CloverViewer">CloverViewer</a>（Rust + egui）的重实现。<br>
    Rust 后端 + Web 前端（Vite + TypeScript），内置 <a href="https://modelcontextprotocol.io">MCP Server</a>。
  </p>
  <p>
    <img src="https://img.shields.io/github/v/release/smallclover/CloverViewer-Tauri?display_name=tag&sort=semver&color=2E7D32" alt="Latest release">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
    <img src="https://img.shields.io/badge/platform-Windows-blue" alt="Platform: Windows">
    <img src="https://img.shields.io/badge/Tauri-2-FFC131" alt="基于 Tauri 2">
    <img src="https://img.shields.io/badge/MCP-Server-9C29AC" alt="MCP Server">
  </p>
  <p>
    <a href="https://github.com/smallclover"><img src="https://img.shields.io/badge/Author-smallclover-green" alt="作者: smallclover"></a>
    <a href="https://smallclover.github.io/CloverViewer-Tauri/"><img src="https://img.shields.io/badge/%E4%BB%8B%E7%BB%8D%E9%A1%B5-%E5%9C%A8%E7%BA%BF%E6%9F%A5%E7%9C%8B-2E7D32" alt="CloverViewer 在线介绍页"></a>
  </p>
</div>

---

## 📖 简介

CloverViewer-Tauri 是一款**免费开源的 Windows 图片查看器与截图工具**，基于 **Tauri 2** 构建。它是对原版 [CloverViewer](https://github.com/smallclover/CloverViewer)（egui/eframe 版）的**新一代重实现**——**界面全面更新换代**：从原版 Rust 原生 egui 界面，升级为基于 Web（Vite + TypeScript + Canvas）的现代化自定义无边框界面，观感与交互焕然一新。在功能对齐之外新增了**内置 MCP Server**，让 Claude Desktop 等 AI 客户端可以直接调用截图能力。轻量、快速，把图片浏览、多屏截图、标注与 OCR 装进一个便携的 Windows 应用。

## 🎯 适合谁用

*   **想换掉系统看图工具**：免费、开源、无广告、无捆绑，启动即用，不用注册登录。
*   **经常截图写文档 / 提 bug**：多屏截图 + 矩形、椭圆、箭头、画笔、马赛克、文字标注，Enter 直接复制。
*   **需要长截图**：聊天记录、网页全文、长列表、日志与代码 diff 一屏截不下时，滚动拼接成一张长图。
*   **需要截图取字**：使用 Windows 原生 OCR 或可选本地高精度引擎提取中 / 英 / 日文字，分块选取、修改和复制，不用上传到在线服务。
*   **想让 AI 直接看屏幕**：内置 MCP Server，Claude Desktop 等 MCP 客户端可列出显示器、截图、读文字。

## ✨ 功能特性

### 🖼️ 图片查看器

*   **双视图模式**：网格视图（缩略图）与单图视图（大图）切换
*   **大目录友好**：网格虚拟滚动 + 缩略图并发控制、请求合并与缓存；滚动时跳过已离开视野的排队任务，上千张图片的文件夹也能流畅浏览
*   **文件夹浏览**：打开文件夹自动加载全部图片；排序与缩略图大小控件仅在有图片时显示；F5 / Ctrl+R 刷新当前目录，保留当前图片与网格位置，同目录另存副本后自动更新列表
*   **快速导航**：键盘 ←/→ 切换，优先加载当前图片并限制相邻图片预加载；解码完成后平滑切换，快速连切不会显示过期图片
*   **相邻图片预览**：单图画布底部悬浮显示当前图片及前后各两张缩略图，点击即可切换；当前项放大，窄窗口可横向滚动。状态栏文件名前的按钮可即时展开或收起，与设置 → 查看中的开关同步并记住选择，不占用独立画布空间
*   **流畅缩放**：滚轮缩放、原始尺寸和适应窗口带平滑过渡，连续滚动以鼠标位置为中心接续，拖拽立即接管；缩放灵敏度可调，支持系统减少动态效果偏好。适应窗口时使用箭头，可拖动时显示手形
*   **拖拽打开**：图片或文件夹直接拖入窗口
*   **图片属性**：名称 / 路径 / 尺寸 / 大小 / 修改时间 + EXIF（相机、ISO、光圈、快门、焦距、镜头），可打开所在文件夹
*   **右键菜单**：复制图片、复制路径、查看、编辑图片
*   **局域网分享**：右键图片即可生成临时链接和二维码，让同一网络内的设备预览或下载；可在设置中控制有效期和下载一次后失效
*   **旋转与翻转**：R 旋转、H/V 翻转
*   **图片编辑**：从右键菜单或 Ctrl+E 进入；可裁剪、旋转、标注（矩形、椭圆、箭头、画笔、马赛克、文字）、选择删除和撤销/重做。裁切支持九宫格、边角调整和选区平移，框外保留原色并压暗；松开鼠标后平滑居中并调整预览比例，拖动期间比例稳定。底部工具栏按工具显示参数，“保存选项”提供格式、输出比例、另存为副本和覆盖原图；覆盖与放弃未保存编辑均使用应用内确认框。小图预览最多自动放大至 2 倍，并支持滚轮、缩放按钮、适应窗口、100% 与空格/中键平移。缩放控件统一放在底部工具栏，裁剪模式下框固定，通过缩放和平移框内图片调整构图；保存期间新增的修改仍受退出确认保护。导出为静态图片，不保留原始 EXIF/ICC，JPEG 以 90% 质量将透明区域填白。裁剪先作为草稿，Enter 应用、Esc 取消；旋转有独立按钮。图形与文字可重新选中移动、拖动角点旋转，画笔和马赛克固定；文字输入完成即可调整。重置全部编辑可撤销，参数栏与绘图工具组居中，未选中标注时收起调整提示。 新标注的线粗、字号、箭头与马赛克大小按当前预览缩放换算，工具切换保留尺寸选择。

*   **相框与水印**：截图点击「图片美化」直接进入图片编辑器；选择清爽分享、Mac 浅色/深色窗口、极简浏览器、黑框画廊、浅木装裱或拍立得样式，调整背景配色和小/中/大留白即可导出。圆角、阴影和相框细节由预设统一决定；文字与 PNG Logo 水印支持大小、不透明度、九宫格定位和拖动。实时预览与标注共用缩放及底部保存操作，一轮美化合并为一步撤销，支持还原本次、按住对比和个人预设；可选择自动应用到新截图。滚动截图需先在查看器中打开再编辑；美化处理上限为 2400 万像素、单边 32767 px。

### 📸 截图与标注

*   **选区外观**：默认经典黑白虚线；设置 → 截图可切换自定义颜色，选择虚线或实线，选区外加深遮罩便于区分
*   **多显示器支持**：跨屏拼接虚拟桌面截图；后台准备截图窗口并直接传输原始像素，显示前同步窗口与内容区域尺寸，减少等待及偶发画面压缩。拖动选区时底图保持静态，遮罩、边框与放大镜独立更新，减少整幅画面重绘；导出保留原始像素。屏幕增减、排列或 DPI 变化后重建覆盖窗，校验通过后再显示；截图期间布局变化时丢弃旧帧。 工具栏、颜色与大小弹层保持在选区所在屏幕内，窄屏自动换行；鼠标跨屏不会带走工具栏。截图窗口显示后可直接操作，修复主窗口活动时 Alt 热键触发后需要额外点击的问题。
*   **滚动截图（长截图）**：框选可滚动区域后按自己的节奏滚动，程序逐帧按重叠像素配准、只把验证通过的新内容拼接成长图；识别出的固定顶栏仅保留首帧、固定底栏仅保留最后接受帧。配准时忽略固定侧栏的纹理，但不会自动裁掉侧栏，建议只选择正文；完成后可复制、存到桌面或直接在查看器中打开。设置里可开启试验性自动滚动，由程序探测目标应用接受的滚动方式（滚轮消息 / 模拟滚轮 / PageDown / 滚动条）后代为滚动。Enter 完成并预览，Esc 取消并丢弃本次内容；鼠标穿透时同样生效
*   **标注工具**：矩形、椭圆、箭头、画笔、马赛克、文字；线粗、字号、色块大小独立设置，以原图像素（px）计，本次使用中切换工具保留各自大小。图片编辑的初始大小和档位按预览比例调整，大图缩小显示时也能清晰标注；调整窗口不改写已选大小或已有标注。截图与图片编辑共用透明文字框，四角圆形标记清晰可见，输入框随内容自动伸缩；马赛克显示笔刷大小光圈，连续涂抹固定原图色块，预览与停笔后的效果一致。透明图片的马赛克色块使用实色底，遮住原图细节，未涂区域保持透明
*   **颜色与大小**：点击工具栏色块打开调色盘；点击大小按钮，按当前工具设置线粗、字号或马赛克色块大小
*   **放大镜取色**：未框选和正在框选时自动显示，选区确定后隐藏；按住 **Alt** 可在画布上临时显示坐标与像素色值，**Alt+C**（可自定义）复制颜色
*   **撤销/重做**：Ctrl+Z / Ctrl+Y
*   **导出**：Enter 复制到剪贴板 / 保存到桌面；工具栏可直接在查看器中打开普通截图
*   **局域网分享**：标注完成后可生成临时链接和二维码，供同一网络内的设备预览或下载截图
*   **OCR 文字识别**：默认使用 Windows 原生 OCR，支持自动或指定中英日语言，保留原图细节并在无结果时轻度增强；设置 → 文字识别 可按需下载 PP-OCRv5 高精度组件并手动切换或删除（首次下载约 154 MiB，安装后约 98 MiB，不捆绑模型或运行库）。两种引擎均在本机识别，结果在查看器中复制或临时编辑。 下载完成后显示「已下载」，并区分就绪与已启用状态。
*   **分块取字与原图联动**：识别结果支持按段落或按行查看，原图点选、Ctrl 多选与拖框选行；右侧可以拖选一句话、修改单段，复制所选或全部，并选择整理段落或保留原换行。分块与全文共享修改，支持原图缩放、旋转、翻转及窄窗口布局。修改与选择仅在当前会话保留，复杂排版可按行选择兜底。

### 🤖 MCP Server（新增）

内置 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，把截图能力暴露给 AI 客户端：

*   **stdio 模式**：`CloverViewer.exe --mcp`（单实例独立进程）
*   **HTTP 模式**：`CloverViewer.exe --mcp-http --token <secret> [--port 3000]`（streamable HTTP，端点 `/mcp`，仅监听本机；请求须带 `Authorization: Bearer <secret>`）
*   **工具**：`list_monitors`、`take_screenshot`、`get_screenshot`、`ocr_screenshot` 与 `delete_screenshot`。截图支持活动窗口、指定显示器、全部显示器和区域；默认直接返回供视觉模型使用的图片内容和结构化元数据。仅在客户端可访问 MCP 服务本地文件系统时，才使用 `delivery: "path"` 或 `"both"` 请求路径。

在 Claude Desktop 的 `claude_desktop_config.json` 中接入：

```json
{
  "mcpServers": {
    "clover-viewer": {
      "command": "C:\\Path\\To\\CloverViewer.exe",
      "args": ["--mcp"]
    }
  }
}
```

完整的接入方式、工具参数、使用场景与隐私说明见 [MCP 使用指南](docs/mcp-guide.md)。

### ⚙️ 系统功能

*   **三语言界面**：简体中文 / English / 日本語，即时切换；同步页面语言标记，设置说明与编辑工具栏适配窄窗口
*   **明暗主题**：跟随系统 / 深色 / 浅色；设置与图片编辑使用统一的圆角下拉菜单，支持鼠标和键盘选择；系统主题变化时立即同步
*   **界面缩放**：默认 100%，可在设置 → 外观与桌宠中选择 110% / 125% / 150%，主界面和截图界面立即同步并记住选择；截图输出仍保留原始像素
*   **标题栏菜单**：文件（打开图片、文件夹与设置）/ 截图（截图、滚动截图与截图设置）/ 帮助（快捷键、检查更新与关于）。F1 打开双栏快捷键速查弹窗，点击空白处或 Esc 收起菜单
*   **全局热键**：默认 **Alt+S** 唤起截图（托盘状态下可用，可自定义）
*   **系统托盘**：关闭窗口可选最小化到托盘；右键提供显示主窗口、截图、滚动截图、设置与退出，菜单语言与截图热键提示随设置更新
*   **开机自启**：写 `HKCU\...\Run` 注册表，`--startup` 参数静默启动到托盘
*   **单实例**：named mutex 防重复打开
*   **配置兼容**：与 egui 版共用 `%APPDATA%\CloverViewer\config.json`（失败回退 exe 旁，便携模式）
*   **桌面小宠物**：可显示 Live2D 角色，支持待机、眨眼、定时点头和鼠标跟随；可拖动，并可在设置中用 60%–200% 滑杆缩放，截图时自动隐藏；右键可选择截图、滚动截图、打开主界面或退出。
*   **窗口角色装饰**：设置 → 外观与桌宠可选择关闭、A「右下角倚靠」或 B「右上角探头」，并调整 60%–140% 大小。透明角色随主窗口移动，鼠标穿透，最大化、全屏和截图时自动隐藏；与独立桌宠分开控制。
*   **设置面板**：全屏设置按常规、外观与桌宠、图片查看、截图、文字识别、快捷键、局域网分享、更新与缓存八类组织，支持按分类名、分组名或选项搜索；OCR 组件下载、引擎切换、窗口装饰及分享规则各有独立入口
*   **临时缓存管理**：设置 → 更新与缓存 显示 `%TEMP%\CloverViewer` 里普通截图、长截图及 OCR 在查看器中打开时产生的临时 PNG 文件数与占用，可设保留期（默认 7 天，启动时自动清理）或按时间范围立即清理；此处不清理缩略图或 MCP 截图存储。 无法读取或删除的文件会报告失败原因，部分失败不会误报清理成功。
*   **软件更新**：仅手动检查更新；持续显示下载进度与分阶段错误，网络下载失败最多尝试三次，签名验证通过后才安装

## 🖼️ 支持的格式

PNG · JPEG · GIF · BMP · WebP · TIFF (.tif / .tiff) · AVIF

## 🔧 技术栈

| 层 | 技术 |
|---|---|
| 框架 | [Tauri 2](https://tauri.app) |
| 前端 | Vite · TypeScript · Canvas |
| 截图 | xcap |
| OCR | Windows.Media.Ocr（默认）；可选下载 PP-OCRv5 + ONNX Runtime |
| MCP | rmcp + axum（streamable HTTP） |
| 图片 | image · imageproc · kamadak-exif |
| 系统集成 | global-shortcut · single-instance · tray · winreg |

## 📦 安装

前往 [Releases](https://github.com/smallclover/CloverViewer-Tauri/releases) 下载 `CloverViewer_x.y.z_x64-setup.exe`（NSIS 安装器，per-user 安装无需管理员权限）。也可直接使用便携版 `CloverViewer.exe`。

## 🛠️ 从源码构建

前置：[Rust](https://www.rust-lang.org/tools/install) + Node.js 24.x（满足当前锁定依赖的要求）+ WebView2 Runtime（需已安装）。

```shell
npm install

# 开发模式
npm run tauri dev

# Debug 构建
cd src-tauri && cargo build

# Release + NSIS 安装包
npm run tauri build
# 产物：src-tauri/target/release/cloverviewer-tauri.exe
#       src-tauri/target/release/bundle/nsis/CloverViewer_x.y.z_x64-setup.exe
```

> **国内网络注意**：`tauri build` 首次会从 GitHub 下载 NSIS 工具链（nsis-3.11.zip + nsis_tauri_utils.dll，缓存于 `%LOCALAPPDATA%\tauri\NSIS`）。若下载卡住，可设置镜像：
>
> ```shell
> # PowerShell（当前会话）
> $env:TAURI_BUNDLER_TOOLS_GITHUB_MIRROR = "https://gh-proxy.com/https://github.com"
> npm run tauri build
> ```
>
> 镜像不可用时：用浏览器手动下载上面两个文件，解压 zip 并将内容放入 `%LOCALAPPDATA%\tauri\NSIS\`，DLL 放入其 `Plugins\x86-unicode\` 下即可跳过下载。

## ⌨️ 快捷键

### 图片查看器

| 快捷键 | 功能 |
|--------|------|
| ← / → | 上一张 / 下一张 |
| 滚轮 | 缩放（单图视图） |
| Ctrl+O | 打开文件夹 |
| Ctrl+Shift+O | 打开图片 |
| Ctrl+E | 编辑当前图片 |
| F5 / Ctrl+R | 刷新当前目录，保留当前位置；编辑中阻止整页重载 |
| Space + Drag / Middle Drag | 编辑预览或 OCR 原图平移 |
| F1 | 打开快捷键说明 |
| Tab | 网格 / 单图切换；预览控件内用于焦点导航 |
| Esc | 单图返回网格；裁剪中取消草稿；其余编辑状态退出，未保存时先确认 |
| Enter | 裁剪中应用草稿；文字输入中提交并进入调整 |
| 0 / 1 | 适应窗口 / 原始尺寸 |
| R / H / V | 旋转 / 水平翻转 / 垂直翻转 |

### OCR 结果面板

| 操作 | 功能 |
|------|------|
| 点击原图文字 / Ctrl+点击 | 选择一块 / 增减多选 |
| 在原图拖框 | 选择相交的识别行 |
| 勾选右侧段落 / 拖选正文 | 选择整块 / 选择精确字符 |
| Ctrl+C | 优先复制拖选字符；否则复制已选块 |
| Space+拖动 / 中键拖动 | 在 OCR 选字模式中平移原图 |
| Esc | 取消拖动或修改 → 清空选择 → 关闭结果面板 |

原图选取以识别行或块为单位；右侧正文可选到字符。修改后的段落按整块复制，避免带出修改前的旧行；分组不准时切换“按行”。

### 截图工具

| 快捷键 | 功能 |
|--------|------|
| **Alt+S**（可自定义） | 全局唤起截图 |
| **Alt+Shift+S**（可自定义） | 进入滚动截图：框选或单击选择窗口后，点击“开始”或按 Enter 开始采集；默认手动滚动，自动滚动需在设置里开启试验功能 |
| Esc | 取消截图 / 取消滚动截图并丢弃本次内容 / 关闭结果预览 |
| Enter | 普通截图复制选区；滚动截图开始采集 / 完成并预览；结果预览中复制 |
| Delete | 删除选中标注 |
| Ctrl+Z / Ctrl+Y | 撤销 / 重做 |
| **Alt**（按住） | 临时显示截图放大镜 |
| **Alt+C**（可自定义） | 复制放大镜中心色值 |

## 🔄 与原版的关系

*   原 egui 版：[CloverViewer](https://github.com/smallclover/CloverViewer)（eframe + 全 Rust UI）
*   本仓库：Tauri 2 重实现；**界面全新换代**，改用 Web 技术栈（HTML/CSS/TS）做出自定义无边框窗口，而非原版的 egui 原生控件
*   配置文件互通

## ❓ 常见问题（FAQ）

### CloverViewer 是免费的吗？可以商用吗？

本仓库自有代码免费开源，协议为 [MIT](LICENSE)：个人使用、公司内部使用和二次开发都可以，只需保留版权声明。随桌宠打包的 Live2D 组件及角色资产适用独立条款，公开分发前请查看 [第三方声明](THIRD_PARTY_NOTICES.md)。

### 支持哪些 Windows 版本？

Windows 10 / 11，需要已安装 WebView2 Runtime。安装包是 NSIS 的 per-user 安装，不需要管理员权限；也可以直接使用便携版 `CloverViewer.exe`。

### 会把我浏览的图片或截图上传吗？

不会自动上传到第三方服务。图片浏览、截图、标注、长截图拼接和 OCR 全部在本机完成，应用没有账号体系，也不收集使用数据。主动创建局域网分享时，同一网络内持有链接的设备可临时访问该图片；启用 MCP 后，截图可交给你连接的 AI 客户端。软件更新只在你到「设置 → 更新与缓存 → 软件更新」点击「检查更新」时访问 GitHub Releases，并在确认更新后下载安装包，不在后台自动检查。 高精度 OCR 组件仅在设置中主动点击下载时连接 ModelScope 与 GitHub，识别图片不上传。

### 长截图（滚动截图）支持所有应用吗？

不保证 100% 成功。默认是**手动滚动优先**：你按自己的节奏滚动，程序逐帧配准并只把验证通过的新内容追加进长图；自动注入滚动属于设置里的试验功能，默认关闭。目标应用有粘性标题栏、动态内容或大面积动画时成功率会下降，失败或中途停止时已捕获的部分会保留。

### 和其它截图工具有什么不同？

它把「图片查看器」和「截图标注」合在同一个免费开源应用里，并且内置 MCP Server 让 AI 客户端可以直接调用截图与 OCR。长截图走的是「真实帧 + 重叠像素配准」路线：输出中的每个像素都来自某一帧真实屏幕画面，而不是推算出来的。

### 和原版 CloverViewer（egui 版）是什么关系？

本仓库是 Tauri 2 重实现：Rust 后端 + Web 前端（Vite + TypeScript + Canvas），界面由 egui 原生控件换成自定义无边框窗口。两者配置文件互通，共用 `%APPDATA%\CloverViewer\config.json`。

### 怎么让 Claude Desktop 用上截图能力？

按 [MCP 使用指南](docs/mcp-guide.md) 在 `claude_desktop_config.json` 中配置 `CloverViewer.exe --mcp`，即可调用 `list_monitors`、`take_screenshot`、`get_screenshot`、`ocr_screenshot` 与 `delete_screenshot`。

## 📚 文档

| 文档 | 内容 |
|------|------|
| [MCP 使用指南](docs/mcp-guide.md) | 接入方式、工具参数、典型工作流、隐私与限制 |
| [项目架构与目录说明](docs/architecture.md) | 前端 / Rust 后端目录职责、数据流与维护边界 |
| [OCR 引擎与可选组件](docs/ocr.md) | 中英日语言设置、高精度组件下载与删除、离线识别、体积与许可 |
| [滚动截图 V2 设计](docs/scroll-capture-v2.md) | 手动滚动优先的不变量、模块划分与验证方式 |
| [软件更新与发布签名配置](docs/auto-update.md) | 手动更新、签名密钥、GitHub Secrets 与更新验证步骤 |
| [桌宠资产说明](docs/desktop-pet-rigging.md) | Live2D 模型位置、运行范围与导出检查 |
| [截图选区拖动优化验证](docs/screenshot-selection-smoothness-validation.md) | 已记录的功能与绘制检查、真实桌面验证边界 |
| [业务源码文件行数规范](docs/code-size-guidelines.md) | 拆分门槛、例外说明与当前基线 |
| [发布流程](docs/release.md) | 维护者用：版本准备、预检、构建、发布、发布后验证与回滚 |
| [仓库 SEO 与元数据清单](docs/seo.md) | 维护者用：关键词落位、Topics / Description、Pages 与发版检查 |
| [更新日志](CHANGELOG.md) | 每个版本的用户可见变化 |
| [在线介绍页](https://smallclover.github.io/CloverViewer-Tauri/) | 功能概览、常见问题与下载入口 |

## 📝 更新日志

每个版本的用户可见变化见 [CHANGELOG.md](./CHANGELOG.md)。

## 📄 开源协议

自有代码采用 [MIT License](LICENSE)。第三方组件与桌宠资产的适用条款见 [第三方声明](THIRD_PARTY_NOTICES.md)。
