<div align="center">
  <img src="src-tauri/icons/128x128.png" width="120" alt="CloverViewer Logo">
  <h1>CloverViewer-Tauri 三叶草图片查看与截图工具</h1>
  <p>
    [CloverViewer](https://github.com/smallclover/CloverViewer)（Rust + egui）的 Tauri 2 重实现。<br>
    Rust 后端 + Web 前端（Vite + TypeScript），新增内置 MCP Server。
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.1.0-2E7D32" alt="Version">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
    <img src="https://img.shields.io/badge/platform-Windows-blue" alt="Platform: Windows">
    <img src="https://img.shields.io/badge/Tauri-2-FFC131" alt="Tauri 2">
  </p>
  <p>
    <a href="https://github.com/smallclover"><img src="https://img.shields.io/badge/Author-smallclover-green" alt="Author"></a>
  </p>
</div>

---

## 📖 简介

CloverViewer-Tauri 是一个免费开源的 Windows 轻量级工具，集图片浏览与屏幕截图于一体。本项目是原 [CloverViewer](https://github.com/smallclover/CloverViewer)（egui/eframe 版）的 Tauri 2 重实现，**界面全面更新换代**——从原版的 Rust 原生 egui UI，升级为基于 Web（Vite + TypeScript + Canvas）的现代化自定义无边框界面，观感与交互焕然一新。功能对齐之外新增了**内置 MCP Server**——可以让 Claude Desktop 等 AI 客户端直接调用截图能力。

## ✨ 功能特性

### 🖼️ 图片查看器

*   **双视图模式**：网格视图（缩略图）与单图视图（大图）切换
*   **文件夹浏览**：打开文件夹自动加载全部图片
*   **快速导航**：键盘 ←/→ 切换，相邻图片预加载
*   **流畅缩放**：滚轮缩放 + 拖拽平移，缩放灵敏度可调
*   **拖拽打开**：图片或文件夹直接拖入窗口
*   **图片属性**：名称 / 路径 / 尺寸 / 大小 / 修改时间 + EXIF（相机、ISO、光圈、快门、焦距、镜头）
*   **右键菜单**：复制图片、复制路径、查看
*   **旋转与翻转**：R 旋转、H/V 翻转

### 📸 截图与标注

*   **多显示器支持**：跨屏拼接虚拟桌面截图
*   **标注工具**：矩形、椭圆、箭头、画笔、马赛克、文字
*   **颜色与线宽**：长按工具图标打开调色盘
*   **放大镜取色**：实时显示坐标与像素色值，**Alt+C**（可自定义）复制颜色
*   **撤销/重做**：Ctrl+Z / Ctrl+Y
*   **导出**：Enter 复制到剪贴板 / 保存到桌面
*   **OCR 文字识别**：基于 Windows 原生 UWP OCR 引擎（`Windows.Media.Ocr`），中英日等多语言，含灰度 + 2× 最近邻放大预处理

### 🤖 MCP Server（新增）

内置 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，把截图能力暴露给 AI 客户端：

*   **stdio 模式**：`CloverViewer.exe --mcp`（单实例独立进程）
*   **HTTP 模式**：`CloverViewer.exe --mcp-http [--port 8787]`（streamable HTTP，端点 `/mcp`）
*   **工具**：`take_screenshot(target, path)`——支持 `all_monitors` / `monitor:<n>` / `active_window`，截图保存为 PNG 并返回路径

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

### ⚙️ 系统功能

*   **三语言界面**：简体中文 / English / 日本語，即时切换
*   **明暗主题**：跟随系统 / 深色 / 浅色
*   **全局热键**：默认 **Alt+S** 唤起截图（托盘状态下可用，可自定义）
*   **系统托盘**：关闭窗口可选最小化到托盘
*   **开机自启**：写 `HKCU\...\Run` 注册表，`--startup` 参数静默启动到托盘
*   **单实例**：named mutex 防重复打开
*   **配置兼容**：与 egui 版共用 `%APPDATA%\CloverViewer\config.json`（失败回退 exe 旁，便携模式）
*   **设置面板**：语言 / 主题 / 缩放灵敏度 / 截图热键 / 取色热键 / 放大镜 / 最小化到托盘 / 开机自启

## 🖼️ 支持的格式

PNG · JPEG · GIF · BMP · WebP · TIFF

## 🔧 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Tauri 2 |
| 前端 | Vite · TypeScript · Canvas |
| 截图 | xcap |
| OCR | Windows.Media.Ocr（UWP 原生） |
| MCP | rmcp + axum（streamable HTTP） |
| 图片 | image · imageproc · kamadak-exif |
| 系统集成 | global-shortcut · single-instance · tray · winreg |

## 📦 安装

前往 [Releases](https://github.com/smallclover/CloverViewer-Tauri/releases) 下载 `CloverViewer_x.y.z_x64-setup.exe`（NSIS 安装器，per-user 安装无需管理员权限）。也可直接使用绿色版 `CloverViewer.exe`。

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
| Esc | 取消截图 |
| Enter | 复制选区到剪贴板 |
| Delete | 删除选中标注 |
| Ctrl+Z / Ctrl+Y | 撤销 / 重做 |
| **Alt+C**（可自定义） | 复制放大镜中心色值 |

## 🔄 与原版的关系

*   原 egui 版：[CloverViewer](https://github.com/smallclover/CloverViewer)（eframe + 全 Rust UI）
*   本仓库：Tauri 2 重实现；**界面全新换代**，改用 Web 技术栈（HTML/CSS/TS）做出自定义无边框窗口，而非原版的 egui 原生控件
*   配置文件互通，迁移路线与决策记录见 [ROADMAP.md](./ROADMAP.md)
*   迁移动机与取舍详见 ROADMAP「一、为什么迁移 / 什么时候不该迁移」

## 📄 开源协议

[MIT License](LICENSE)
