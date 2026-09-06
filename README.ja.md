<div align="center">
  <img src="src-tauri/icons/128x128.png" width="120" alt="CloverViewer Logo">
  <h1>CloverViewer-Tauri — クローバー画像ビューア &amp; スクリーンショットツール</h1>
  <p>
    <a href="README.md">中文</a> · <a href="README.en.md">English</a> · <b>日本語</b>
  </p>
  <p>
    [CloverViewer](https://github.com/smallclover/CloverViewer)（Rust + egui）の Tauri 2 再実装。<br>
    Rust バックエンド + Web フロントエンド（Vite + TypeScript）、内蔵 MCP Server 付き。
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

## 📖 はじめに

CloverViewer-Tauri は、画像閲覧とスクリーンショットをひとつにまとめた、無料・オープンソースの Windows 向け軽量ツールです。プロジェクトは本来の [CloverViewer](https://github.com/smallclover/CloverViewer)（egui/eframe 版）の Tauri 2 再実装で、**UI を全面的に刷新**しました——従来の Rust ネイティブ egui インターフェースから、Web（Vite + TypeScript + Canvas）ベースのモダンなカスタム・フレームレスインターフェースへと一新されています。見た目も操作感も新しくなりました。機能を揃えたうえで、**内蔵 MCP Server** を追加し、Claude Desktop などの AI クライアントがスクリーンショット機能を直接呼び出せるようにしています。

## ✨ 機能

### 🖼️ 画像ビューア

*   **2つの表示モード**: グリッド表示（サムネイル）と単一画像表示（大画面）を切り替え
*   **フォルダー閲覧**: フォルダーを開くと全画像を自動読込
*   **すばやいナビゲーション**: ←/→ キーで切替、隣接画像をプリロード
*   **なめらかなズーム**: ホイールでズーム + ドラッグでパン、ズーム感度を調整可能
*   **ドラッグ&ドロップで開く**: 画像やフォルダーをウィンドウへ直接ドロップ
*   **画像プロパティ**: 名前 / パス / サイズ / 変更時刻 + EXIF（カメラ、ISO、絞り、シャッター速度、焦点距離、レンズ）
*   **右クリックメニュー**: 画像コピー、パスコピー、表示
*   **回転と反転**: R で回転、H/V で反転

### 📸 スクリーンショットと注釈

*   **マルチモニター対応**: 複数画面を跨いで仮想デスクトップ全体を連結キャプチャ
*   **注釈ツール**: 矩形、楕円、矢印、ペン、モザイク、テキスト
*   **色と線幅**: ツールアイコンを長押しでカラーパレットを開く
*   **拡大鏡カラーピッカー**: 座標とピクセル色をリアルタイム表示、**Alt+C**（カスタマイズ可）で色をコピー
*   **元に戻す / やり直す**: Ctrl+Z / Ctrl+Y
*   **エクスポート**: Enter でクリップボードへコピー / デスクトップへ保存
*   **OCR 文字認識**: Windows ネイティブ UWP OCR エンジン（`Windows.Media.Ocr`）ベース、中英日など複数言語対応。グレースケール + 2× ニアレストネイバー拡大の前処理付き

### 🤖 MCP Server（新規）

[Model Context Protocol](https://modelcontextprotocol.io) サーバーを内蔵し、スクリーンショット機能を AI クライアントに公開します:

*   **stdio モード**: `CloverViewer.exe --mcp`（単一インスタンスの独立プロセス）
*   **HTTP モード**: `CloverViewer.exe --mcp-http [--port 8787]`（streamable HTTP、エンドポイント `/mcp`）
*   **ツール**: `take_screenshot(target, path)` — `all_monitors` / `monitor:<n>` / `active_window` に対応、PNG として保存しパスを返す

Claude Desktop の `claude_desktop_config.json` で接続:

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

### ⚙️ システム機能

*   **3言語UI**: 简体中文 / English / 日本語、その場で切替
*   **ライト/ダークテーマ**: システム追従 / ダーク / ライト
*   **グローバルホットキー**: デフォルト **Alt+S** でスクリーンショット起動（トレイからも利用可、カスタマイズ可）
*   **システムトレイ**: 閉じる時にトレイへ最小化するかを選択可
*   **自動起動**: `HKCU\...\Run` レジストリを書き込み、`--startup` 引数で静かにトレイへ起動
*   **単一インスタンス**: named mutex で多重起動を防止
*   **設定互換**: egui 版と `%APPDATA%\CloverViewer\config.json` を共用（失敗時は exe の隣へフォールバックしポータブルモード）
*   **設定パネル**: 言語 / テーマ / ズーム感度 / スクリーンショットホットキー / カラーホットキー / 拡大鏡 / トレイ最小化 / 自動起動

## 🖼️ 対応フォーマット

PNG · JPEG · GIF · BMP · WebP · TIFF

## 🔧 技術スタック

| レイヤー | 技術 |
|---|---|
| フレームワーク | Tauri 2 |
| フロントエンド | Vite · TypeScript · Canvas |
| スクリーンショット | xcap |
| OCR | Windows.Media.Ocr（ネイティブ UWP） |
| MCP | rmcp + axum（streamable HTTP） |
| 画像 | image · imageproc · kamadak-exif |
| システム連携 | global-shortcut · single-instance · tray · winreg |

## 📦 インストール

[Releases](https://github.com/smallclover/CloverViewer-Tauri/releases) から `CloverViewer_x.y.z_x64-setup.exe` をダウンロード（NSIS インストーラー、per-user インストールで管理者権限不要）。ポータブル版 `CloverViewer.exe` も直接利用できます。

## 🛠️ ソースからのビルド

前提: [Rust](https://www.rust-lang.org/tools/install) + Node.js ≥ 18 + WebView2 Runtime（Windows 10/11 に同梱）。

```shell
npm install

# 開発モード
npm run tauri dev

# Debug ビルド
cd src-tauri && cargo build

# Release + NSIS インストーラー
npm run tauri build
# 出力: src-tauri/target/release/cloverviewer-tauri.exe
#        src-tauri/target/release/bundle/nsis/CloverViewer_x.y.z_x64-setup.exe
```

> **中国ネットワーク向け注意（任意）**: 初回の `tauri build` は NSIS ツールチェーンを GitHub からダウンロードします（nsis-3.11.zip + nsis_tauri_utils.dll、`%LOCALAPPDATA%\tauri\NSIS` にキャッシュ）。ダウンロードが詰まったらミラーを設定してください:
>
> ```shell
> # PowerShell（現在のセッション）
> $env:TAURI_BUNDLER_TOOLS_GITHUB_MIRROR = "https://gh-proxy.com/https://github.com"
> npm run tauri build
> ```
>
> ミラーが使えない場合は、上記2ファイルをブラウザで手動ダウンロードし、zip を解凍して内容を `%LOCALAPPDATA%\tauri\NSIS\` に、DLL をその `Plugins\x86-unicode\` に配置すればダウンロードを回避できます。

## ⌨️ ショートカット

### 画像ビューア

| ショートカット | 機能 |
|--------|------|
| ← / → | 前へ / 次へ |
| ホイール | ズーム（単一画像表示） |
| Ctrl+O | フォルダーを開く |

### スクリーンショットツール

| ショートカット | 機能 |
|--------|------|
| **Alt+S**（カスタマイズ可） | グローバルでスクリーンショット起動 |
| Esc | スクリーンショットをキャンセル |
| Enter | 選択範囲をクリップボードへコピー |
| Delete | 選択した注釈を削除 |
| Ctrl+Z / Ctrl+Y | 元に戻す / やり直す |
| **Alt+C**（カスタマイズ可） | 拡大鏡中心の色をコピー |

## 🔄 元バージョンとの関係

*   元は egui 版: [CloverViewer](https://github.com/smallclover/CloverViewer)（eframe + 全 Rust UI）
*   本リポジトリ: Tauri 2 再実装。**UI を全面的に刷新**し、従来の egui ネイティブコントロールではなく Web スタック（HTML/CSS/TS）でカスタム・フレームレスウィンドウを構築
*   設定ファイルは互換。移行ルートと判断記録は [ROADMAP.md](./ROADMAP.md) を参照
*   移行の理由とトレードオフは ROADMAP「一、为什么迁移 / 什么时候不该迁移」に詳述

## 📄 ライセンス

[MIT License](LICENSE)
