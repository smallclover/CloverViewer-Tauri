<div align="center">
  <img src="public/logo.png" width="120" alt="CloverViewer — open-source Windows image viewer and screenshot tool">
  <h1>CloverViewer-Tauri — Open-Source Windows Image Viewer &amp; Screenshot Tool (Tauri 2)</h1>
  <p>
    <a href="README.md">中文</a> · <b>English</b> · <a href="README.ja.md">日本語</a>
  </p>
  <p>
    A free, lightweight Windows app for browsing images and capturing/annotating screenshots — rebuilt with <a href="https://tauri.app">Tauri 2</a> from the original <a href="https://github.com/smallclover/CloverViewer">CloverViewer</a> (Rust + egui).<br>
    Rust backend + Web frontend (Vite + TypeScript), with a built-in <a href="https://modelcontextprotocol.io">MCP Server</a>.
  </p>
  <p>
    <img src="https://img.shields.io/github/v/release/smallclover/CloverViewer-Tauri?display_name=tag&sort=semver&color=2E7D32" alt="Latest release">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
    <img src="https://img.shields.io/badge/platform-Windows-blue" alt="Platform: Windows">
    <img src="https://img.shields.io/badge/Tauri-2-FFC131" alt="Built with Tauri 2">
    <img src="https://img.shields.io/badge/MCP-Server-9C29AC" alt="MCP Server">
  </p>
  <p>
    <a href="https://github.com/smallclover"><img src="https://img.shields.io/badge/Author-smallclover-green" alt="Author: smallclover"></a>
    <a href="https://smallclover.github.io/CloverViewer-Tauri/"><img src="https://img.shields.io/badge/Landing%20page-view%20online-2E7D32" alt="CloverViewer landing page"></a>
  </p>
</div>

---

## 📖 Introduction

CloverViewer-Tauri is a **free, open-source Windows image viewer and screenshot tool** built with **Tauri 2**. It is the next-generation reimplementation of the original [CloverViewer](https://github.com/smallclover/CloverViewer) (egui/eframe version) — **with a complete UI overhaul**: the Rust-native egui interface is replaced by a modern, custom, frameless interface built on the Web (Vite + TypeScript + Canvas). It looks and feels brand new. On top of feature parity, it adds a **built-in MCP Server**, letting AI clients such as Claude Desktop call the screenshot capability directly. Lightweight and fast, it packs image browsing, multi-monitor screenshot capture, annotation, and OCR into one portable Windows app.

## 🎯 Who It Is For

*   **Anyone replacing the built-in viewer**: free, open source, no ads, no bundled extras, no account or sign-in.
*   **Anyone documenting bugs or writing guides**: multi-monitor capture plus rectangle, ellipse, arrow, pen, mosaic and text annotations; press Enter to copy.
*   **Anyone who needs long screenshots**: stitch chat logs, full web pages, long lists, logs or code diffs into one tall image.
*   **Anyone extracting text from the screen**: native Windows OCR for Chinese, English and Japanese — nothing is uploaded.
*   **Anyone letting AI see the screen**: the built-in MCP Server lets Claude Desktop and other MCP clients list monitors, take screenshots and read text.

## ✨ Features

### 🖼️ Image Viewer

*   **Dual view modes**: grid view (thumbnails) and single-image view (large image)
*   **Large folders stay smooth**: virtualized grid scrolling plus an LRU thumbnail cache, so folders with thousands of images keep scrolling fluidly
*   **Folder browsing**: opening a folder loads all images automatically
*   **Quick navigation**: ←/→ to switch, with preloading of adjacent images
*   **Smooth zoom**: mouse-wheel zoom + drag to pan, adjustable zoom sensitivity
*   **Drag & drop open**: drag images or a folder directly into the window
*   **Image properties**: name / path / dimensions / size / modified time + EXIF (camera, ISO, aperture, shutter speed, focal length, lens)
*   **Right-click menu**: copy image, copy path, view, edit image
*   **LAN sharing**: right-click an image to create a temporary link and QR code for devices on the same network to preview or download; configure its lifetime and one-download expiry in Settings
*   **Rotate & flip**: R to rotate, H/V to flip
*   **Image editing**: enter from the toolbar, Edit menu, or right-click menu; crop, rotate, annotate (rectangle, ellipse, arrow, pen, mosaic, text), select/delete, undo/redo, and export PNG / JPEG / WebP or overwrite the source image

### 📸 Screenshot & Annotation

*   **Multi-monitor support**: stitches a virtual-desktop screenshot across screens
*   **Scrolling capture (long screenshot)**: select a scrollable region and scroll at your own pace; each frame is registered by overlapping pixels and only verified new content is appended, while sticky headers, pinned footers and fixed sidebars are skipped. The result can be copied, saved to Desktop, or opened in the viewer. Experimental auto-scroll can be enabled in settings, where the app probes which scroll method the target accepts (wheel message / synthetic wheel / PageDown / scrollbar) and scrolls for you
*   **Annotation tools**: rectangle, ellipse, arrow, pen, mosaic, text
*   **Color & line width**: long-press a tool icon to open the color palette
*   **Magnifier color picker**: live coordinates and pixel color values; **Alt+C** (customizable) copies the color
*   **Undo/Redo**: Ctrl+Z / Ctrl+Y
*   **Export**: Enter to copy to clipboard / save to Desktop; the toolbar can open a regular screenshot directly in the viewer
*   **LAN sharing**: after annotating, create a temporary link and QR code for devices on the same network to preview or download the screenshot
*   **OCR text recognition**: based on the native Windows UWP OCR engine (`Windows.Media.Ocr`), multi-language (Chinese/English/Japanese), with grayscale + 2× nearest-neighbor upscaling preprocessing

### 🤖 MCP Server (New)

A built-in [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the screenshot capability to AI clients:

*   **stdio mode**: `CloverViewer.exe --mcp` (independent single-instance process)
*   **HTTP mode**: `CloverViewer.exe --mcp-http --token <secret> [--port 3000]` (streamable HTTP at `/mcp`, local-only; requests must include `Authorization: Bearer <secret>`)
*   **Tools**: `list_monitors`, `take_screenshot`, `get_screenshot`, `ocr_screenshot`, and `delete_screenshot`. Screenshots can target the active window, a monitor, all monitors, or a region. By default they return image content and structured metadata for vision-capable clients; request `delivery: "path"` or `"both"` only when the client can access the MCP server's local filesystem.

Wire it up in Claude Desktop's `claude_desktop_config.json`:

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

### ⚙️ System Features

*   **Trilingual UI**: 简体中文 / English / 日本語, switchable on the fly
*   **Light/dark theme**: follow system / dark / light
*   **Title-bar menus**: File (open folder) / Edit (settings) / Help (about CloverViewer); close them by clicking elsewhere or pressing Esc
*   **Global hotkey**: default **Alt+S** to summon the screenshot (available from tray; customizable)
*   **System tray**: optionally minimize to tray on close
*   **Launch on startup**: writes `HKCU\...\Run` registry; `--startup` argument silently starts into tray
*   **Single instance**: named mutex prevents repeated launches
*   **Config compatibility**: shares `%APPDATA%\CloverViewer\config.json` with the egui version (falls back next to the exe for portable mode)
*   **Settings panel**: a full-page settings screen with categories and search (General / View / Capture / LAN sharing / Hotkeys / Cache) and a description under every option — language, theme, zoom sensitivity, the three global hotkeys, magnifier, minimize to tray, launch on startup, software updates and LAN-sharing rules
*   **Temporary cache management**: Settings → Cache shows the file count and size of temporary long screenshots in `%TEMP%\CloverViewer`, lets you set a retention period (7 days by default, cleaned on startup) or clear by age on demand

## 🖼️ Supported Formats

PNG · JPEG · GIF · BMP · WebP · TIFF

## 🔧 Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Tauri 2](https://tauri.app) |
| Frontend | Vite · TypeScript · Canvas |
| Screenshot | xcap |
| OCR | Windows.Media.Ocr (native UWP) |
| MCP | rmcp + axum (streamable HTTP) |
| Images | image · imageproc · kamadak-exif |
| System integration | global-shortcut · single-instance · tray · winreg |

## 📦 Installation

Download `CloverViewer_x.y.z_x64-setup.exe` from [Releases](https://github.com/smallclover/CloverViewer-Tauri/releases) (NSIS installer, per-user install requires no admin rights). You can also use the portable `CloverViewer.exe` directly.

## 🛠️ Build from Source

Prerequisites: [Rust](https://www.rust-lang.org/tools/install) + Node.js ≥ 18 + WebView2 Runtime (bundled with Windows 10/11).

```shell
npm install

# Dev mode
npm run tauri dev

# Debug build
cd src-tauri && cargo build

# Release + NSIS installer
npm run tauri build
# Output: src-tauri/target/release/cloverviewer-tauri.exe
#         src-tauri/target/release/bundle/nsis/CloverViewer_x.y.z_x64-setup.exe
```

> **Note for the China network (optional):** the first `tauri build` downloads the NSIS toolchain from GitHub (nsis-3.11.zip + nsis_tauri_utils.dll, cached under `%LOCALAPPDATA%\tauri\NSIS`). If the download stalls, set up a mirror:
>
> ```shell
> # PowerShell (current session)
> $env:TAURI_BUNDLER_TOOLS_GITHUB_MIRROR = "https://gh-proxy.com/https://github.com"
> npm run tauri build
> ```
>
> If the mirror is unavailable, manually download the two files above, unzip the zip, put the contents into `%LOCALAPPDATA%\tauri\NSIS\`, and place the DLL under its `Plugins\x86-unicode\` folder to skip the download.

## ⌨️ Shortcuts

### Image Viewer

| Shortcut | Function |
|--------|------|
| ← / → | Previous / Next |
| Mouse-wheel | Zoom (single-image view) |
| Ctrl+O | Open folder |

### Screenshot Tool

| Shortcut | Function |
|--------|------|
| **Alt+S** (customizable) | Global screenshot |
| **Alt+Shift+S** (customizable) | Go straight into scrolling capture: capturing starts as soon as you select a region (manual scrolling by default; auto-injected scrolling is an experimental setting); clicking a window captures that window |
| Esc | Cancel screenshot / stop scrolling capture (keeps what was captured) |
| Enter | Copy selection to clipboard |
| Delete | Delete selected annotation |
| Ctrl+Z / Ctrl+Y | Undo / Redo |
| **Alt+C** (customizable) | Copy magnifier center color |

## 🔄 Relation to the Original

*   Original egui version: [CloverViewer](https://github.com/smallclover/CloverViewer) (eframe + full-Rust UI)
*   This repo: Tauri 2 reimplementation; **a complete UI generation overhaul** — a custom frameless window built with the Web stack (HTML/CSS/TS) instead of the original egui native controls
*   Configuration files are interchangeable

## ❓ FAQ

### Is CloverViewer free? Can I use it commercially?

Yes. It is free and open source under the [MIT license](LICENSE): personal use, internal company use and derivative work are all fine as long as the copyright notice is kept.

### Which Windows versions are supported?

Windows 10 and 11, relying on the WebView2 runtime that ships with the system. The installer is a per-user NSIS package that needs no administrator rights, and the portable `CloverViewer.exe` works as well.

### Does it upload my images or screenshots?

No. Image browsing, capture, annotation, long-screenshot stitching and OCR all happen locally; there is no account system and no usage data collection. The only network access is the update check, and it contacts GitHub Releases only when you press “Check for updates” under Settings → Software updates — there is no background auto-check.

### Does scrolling capture work in every app?

Not guaranteed. The default flow is **manual-scroll-first**: you scroll at your own pace and the app registers each frame, appending only verified new content. Auto-injected scrolling is an experimental setting that is off by default. Sticky headers, animated or dynamic content lower the success rate, and anything already captured is kept when it stops or fails.

### How is it different from other screenshot tools?

It combines an image viewer and a screenshot annotator in one free, open-source app, and ships an MCP Server so AI clients can call capture and OCR directly. Scrolling capture follows a "real frames + overlap registration" approach: every pixel in the output comes from an actual captured screen frame rather than an estimate.

### How does it relate to the original CloverViewer (egui)?

This repository is the Tauri 2 reimplementation: Rust backend plus a Web frontend (Vite + TypeScript + Canvas), replacing egui native controls with a custom frameless window. Configuration files are interchangeable and share `%APPDATA%\CloverViewer\config.json`.

### How do I let Claude Desktop take screenshots?

Configure `CloverViewer.exe --mcp` in `claude_desktop_config.json` as described in the [MCP guide](docs/mcp-guide.md); the client can then call `list_monitors`, `take_screenshot`, `get_screenshot`, `ocr_screenshot` and `delete_screenshot`.

## 📚 Documentation

| Document | Contents |
|----------|----------|
| [MCP guide](docs/mcp-guide.md) | Setup, tool parameters, typical workflows, privacy and limits |
| [Architecture and directories](docs/architecture.md) | Frontend / Rust backend responsibilities, data flow and maintenance boundaries |
| [Scrolling capture V2 design](docs/scroll-capture-v2.md) | Manual-scroll-first invariants, modules and verification |
| [Auto-update release setup](docs/auto-update.md) | Signing keys, GitHub Secrets and update verification steps |
| [Source file size guidelines](docs/code-size-guidelines.md) | Split thresholds, exceptions and current baseline |
| [Release process](docs/release.md) | Maintainer runbook: version prep, preflight, build, publish, post-release verification and rollback |
| [Repository SEO and metadata checklist](docs/seo.md) | Maintainer notes: keyword placement, topics/description, Pages and release checks |
| [Changelog](CHANGELOG.md) | User-visible changes per release |
| [Landing page](https://smallclover.github.io/CloverViewer-Tauri/) | Feature overview, FAQ and download entry point |

## 📝 Changelog

User-visible changes for each release live in [CHANGELOG.md](./CHANGELOG.md).

## 📄 License

[MIT License](LICENSE)
