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
*   **需要截图取字**：基于 Windows 原生 OCR 提取中 / 英 / 日文字，不用上传到任何在线服务。
*   **想让 AI 直接看屏幕**：内置 MCP Server，Claude Desktop 等 MCP 客户端可列出显示器、截图、读文字。

## ✨ 功能特性

### 🖼️ 图片查看器

*   **双视图模式**：网格视图（缩略图）与单图视图（大图）切换
*   **大目录友好**：网格虚拟滚动 + 缩略图 LRU 缓存，上千张图片的文件夹也能流畅滚动
*   **文件夹浏览**：打开文件夹自动加载全部图片
*   **快速导航**：键盘 ←/→ 切换，相邻图片预加载
*   **流畅缩放**：滚轮缩放 + 拖拽平移，缩放灵敏度可调
*   **拖拽打开**：图片或文件夹直接拖入窗口
*   **图片属性**：名称 / 路径 / 尺寸 / 大小 / 修改时间 + EXIF（相机、ISO、光圈、快门、焦距、镜头）
*   **右键菜单**：复制图片、复制路径、查看
*   **旋转与翻转**：R 旋转、H/V 翻转

### 📸 截图与标注

*   **多显示器支持**：跨屏拼接虚拟桌面截图
*   **滚动截图（长截图）**：框选可滚动区域后按自己的节奏滚动，程序逐帧按重叠像素配准、只把验证通过的新内容拼接成长图，自动跳过吸顶标题栏、吸底工具栏与固定侧栏；完成后可复制、存到桌面或直接在查看器中打开。设置里可开启试验性自动滚动，由程序探测目标应用接受的滚动方式（滚轮消息 / 模拟滚轮 / PageDown / 滚动条）后代为滚动
*   **标注工具**：矩形、椭圆、箭头、画笔、马赛克、文字
*   **颜色与线宽**：长按工具图标打开调色盘
*   **放大镜取色**：实时显示坐标与像素色值，**Alt+C**（可自定义）复制颜色
*   **撤销/重做**：Ctrl+Z / Ctrl+Y
*   **导出**：Enter 复制到剪贴板 / 保存到桌面
*   **OCR 文字识别**：基于 Windows 原生 UWP OCR 引擎（`Windows.Media.Ocr`），中英日等多语言，含灰度 + 2× 最近邻放大预处理

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

*   **三语言界面**：简体中文 / English / 日本語，即时切换
*   **明暗主题**：跟随系统 / 深色 / 浅色
*   **标题栏菜单**：文件（打开文件夹）/ 编辑（设置）/ 帮助（关于 CloverViewer），点击空白处或 Esc 收起
*   **全局热键**：默认 **Alt+S** 唤起截图（托盘状态下可用，可自定义）
*   **系统托盘**：关闭窗口可选最小化到托盘
*   **开机自启**：写 `HKCU\...\Run` 注册表，`--startup` 参数静默启动到托盘
*   **单实例**：named mutex 防重复打开
*   **配置兼容**：与 egui 版共用 `%APPDATA%\CloverViewer\config.json`（失败回退 exe 旁，便携模式）
*   **设置面板**：分类 + 搜索的整页设置（常规 / 查看 / 截图 / 快捷键 / 缓存），每项带说明文字；含语言、主题、缩放灵敏度、截图 / 取色 / 滚动截图三个热键、放大镜、最小化到托盘、开机自启与软件更新
*   **临时缓存管理**：设置 → 缓存 显示 `%TEMP%\CloverViewer` 里临时长截图的文件数与占用，可设保留期（默认 7 天，启动时自动清理）或按时间范围立即清理

## 🖼️ 支持的格式

PNG · JPEG · GIF · BMP · WebP · TIFF

## 🔧 技术栈

| 层 | 技术 |
|---|---|
| 框架 | [Tauri 2](https://tauri.app) |
| 前端 | Vite · TypeScript · Canvas |
| 截图 | xcap |
| OCR | Windows.Media.Ocr（UWP 原生） |
| MCP | rmcp + axum（streamable HTTP） |
| 图片 | image · imageproc · kamadak-exif |
| 系统集成 | global-shortcut · single-instance · tray · winreg |

## 📦 安装

前往 [Releases](https://github.com/smallclover/CloverViewer-Tauri/releases) 下载 `CloverViewer_x.y.z_x64-setup.exe`（NSIS 安装器，per-user 安装无需管理员权限）。也可直接使用便携版 `CloverViewer.exe`。

## 🛠️ 从源码构建

前置：[Rust](https://www.rust-lang.org/tools/install) + Node.js ≥ 18 + WebView2 Runtime（Windows 10/11 自带）。

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

### 截图工具

| 快捷键 | 功能 |
|--------|------|
| **Alt+S**（可自定义） | 全局唤起截图 |
| **Alt+Shift+S**（可自定义） | 直接进入滚动截图（长截图）：框选完即开始捕获（默认手动滚动，自动注入滚动需在设置里开启试验功能）；单击窗口则直接对该窗口开跑 |
| Esc | 取消截图 / 停止滚动捕获（保留已捕获部分） |
| Enter | 复制选区到剪贴板 |
| Delete | 删除选中标注 |
| Ctrl+Z / Ctrl+Y | 撤销 / 重做 |
| **Alt+C**（可自定义） | 复制放大镜中心色值 |

## 🔄 与原版的关系

*   原 egui 版：[CloverViewer](https://github.com/smallclover/CloverViewer)（eframe + 全 Rust UI）
*   本仓库：Tauri 2 重实现；**界面全新换代**，改用 Web 技术栈（HTML/CSS/TS）做出自定义无边框窗口，而非原版的 egui 原生控件
*   配置文件互通

## ❓ 常见问题（FAQ）

### CloverViewer 是免费的吗？可以商用吗？

免费且开源，协议为 [MIT](LICENSE)：个人使用、公司内部使用和二次开发都可以，只需保留版权声明。

### 支持哪些 Windows 版本？

Windows 10 / 11（依赖系统自带的 WebView2 运行时）。安装包是 NSIS 的 per-user 安装，不需要管理员权限；也可以直接使用便携版 `CloverViewer.exe`。

### 会把我浏览的图片或截图上传吗？

不会。图片浏览、截图、标注、长截图拼接和 OCR 全部在本机完成，应用没有账号体系，也不收集使用数据。唯一的联网行为是「检查更新」：只有你在「设置 → 软件更新」中点「检查更新」时，应用才会访问 GitHub Releases 获取版本信息，不会在后台自动联网。

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
| [滚动截图 V2 设计](docs/scroll-capture-v2.md) | 手动滚动优先的不变量、模块划分与验证方式 |
| [自动更新发布配置](docs/auto-update.md) | 签名密钥、GitHub Secrets 与更新验证步骤 |
| [业务源码文件行数规范](docs/code-size-guidelines.md) | 拆分门槛、例外说明与当前基线 |
| [发布流程](docs/release.md) | 维护者用：版本准备、预检、构建、发布、发布后验证与回滚 |
| [仓库 SEO 与元数据清单](docs/seo.md) | 维护者用：关键词落位、Topics / Description、Pages 与发版检查 |
| [更新日志](CHANGELOG.md) | 每个版本的用户可见变化 |
| [在线介绍页](https://smallclover.github.io/CloverViewer-Tauri/) | 功能概览、常见问题与下载入口 |

## 📝 更新日志

每个版本的用户可见变化见 [CHANGELOG.md](./CHANGELOG.md)。

## 📄 开源协议

[MIT License](LICENSE)
