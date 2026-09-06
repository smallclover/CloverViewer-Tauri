<div align="center">
  <img src="src-tauri/icons/128x128.png" width="120" alt="CloverViewer — open-source Windows image viewer and screenshot tool">
  <h1>CloverViewer-Tauri — Open-Source Windows Image Viewer &amp; Screenshot Tool (Tauri 2)</h1>
  <p>
    <a href="README.md">中文</a> · <b>English</b> · <a href="README.ja.md">日本語</a>
  </p>
  <p>
    A free, lightweight Windows app for browsing images and capturing/annotating screenshots — rebuilt with <a href="https://tauri.app">Tauri 2</a> from the original [CloverViewer](https://github.com/smallclover/CloverViewer) (Rust + egui).<br>
    Rust backend + Web frontend (Vite + TypeScript), with a built-in <a href="https://modelcontextprotocol.io">MCP Server</a>.
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.1.0-2E7D32" alt="Version">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
    <img src="https://img.shields.io/badge/platform-Windows-blue" alt="Platform: Windows">
    <img src="https://img.shields.io/badge/Tauri-2-FFC131" alt="Built with Tauri 2">
    <img src="https://img.shields.io/badge/MCP-Server-9C29AC" alt="MCP Server">
  </p>
  <p>
    <a href="https://github.com/smallclover"><img src="https://img.shields.io/badge/Author-smallclover-green" alt="Author: smallclover"></a>
  </p>
</div>

---

## 📖 Introduction

CloverViewer-Tauri is a **free, open-source Windows image viewer and screenshot tool** built with **Tauri 2**. It is the next-generation reimplementation of the original [CloverViewer](https://github.com/smallclover/CloverViewer) (egui/eframe version) — **with a complete UI overhaul**: the Rust-native egui interface is replaced by a modern, custom, frameless interface built on the Web (Vite + TypeScript + Canvas). It looks and feels brand new. On top of feature parity, it adds a **built-in MCP Server**, letting AI clients such as Claude Desktop call the screenshot capability directly. Lightweight and fast, it packs image browsing, multi-monitor screenshot capture, annotation, and OCR into one portable Windows app.

## ✨ Features

### 🖼️ Image Viewer

*   **Dual view modes**: grid view (thumbnails) and single-image view (large image)
*   **Folder browsing**: opening a folder loads all images automatically
*   **Quick navigation**: ←/→ to switch, with preloading of adjacent images
*   **Smooth zoom**: mouse-wheel zoom + drag to pan, adjustable zoom sensitivity
*   **Drag & drop open**: drag images or a folder directly into the window
*   **Image properties**: name / path / dimensions / size / modified time + EXIF (camera, ISO, aperture, shutter speed, focal length, lens)
*   **Right-click menu**: copy image, copy path, view
*   **Rotate & flip**: R to rotate, H/V to flip

### 📸 Screenshot & Annotation

*   **Multi-monitor support**: stitches a virtual-desktop screenshot across screens
*   **Annotation tools**: rectangle, ellipse, arrow, pen, mosaic, text
*   **Color & line width**: long-press a tool icon to open the color palette
*   **Magnifier color picker**: live coordinates and pixel color values; **Alt+C** (customizable) copies the color
*   **Undo/Redo**: Ctrl+Z / Ctrl+Y
*   **Export**: Enter to copy to clipboard / save to Desktop
*   **OCR text recognition**: based on the native Windows UWP OCR engine (`Windows.Media.Ocr`), multi-language (Chinese/English/Japanese), with grayscale + 2× nearest-neighbor upscaling preprocessing

### 🤖 MCP Server (New)

A built-in [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the screenshot capability to AI clients:

*   **stdio mode**: `CloverViewer.exe --mcp` (independent single-instance process)
*   **HTTP mode**: `CloverViewer.exe --mcp-http [--port 8787]` (streamable HTTP, endpoint `/mcp`)
*   **Tool**: `take_screenshot(target, path)` — supports `all_monitors` / `monitor:<n>` / `active_window`, saves the screenshot as PNG and returns the path

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
*   **Global hotkey**: default **Alt+S** to summon the screenshot (available from tray; customizable)
*   **System tray**: optionally minimize to tray on close
*   **Launch on startup**: writes `HKCU\...\Run` registry; `--startup` argument silently starts into tray
*   **Single instance**: named mutex prevents repeated launches
*   **Config compatibility**: shares `%APPDATA%\CloverViewer\config.json` with the egui version (falls back next to the exe for portable mode)
*   **Settings panel**: language / theme / zoom sensitivity / screenshot hotkey / color hotkey / magnifier / minimize to tray / launch on startup

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
| Esc | Cancel screenshot |
| Enter | Copy selection to clipboard |
| Delete | Delete selected annotation |
| Ctrl+Z / Ctrl+Y | Undo / Redo |
| **Alt+C** (customizable) | Copy magnifier center color |

## 🔄 Relation to the Original

*   Original egui version: [CloverViewer](https://github.com/smallclover/CloverViewer) (eframe + full-Rust UI)
*   This repo: Tauri 2 reimplementation; **a complete UI generation overhaul** — a custom frameless window built with the Web stack (HTML/CSS/TS) instead of the original egui native controls
*   Config files are interchangeable; see [ROADMAP.md](./ROADMAP.md) for the migration route and decision log
*   Migration rationale and trade-offs are detailed in ROADMAP, "1. Why migrate / when not to"

## 📄 License

[MIT License](LICENSE)
