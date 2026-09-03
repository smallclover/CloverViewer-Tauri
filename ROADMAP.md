# CloverViewer → CloverViewer-Tauri 迁移路线图

> **状态（2026-09）：Phase 0-4 全部完成**，v0.1.0 已可发布（NSIS 安装包 + 源码构建均可）。本文档保留作为迁移决策与实现记录。

> 源项目：`D:\programing\CloverViewer`（egui/eframe 0.36，约 12.9k 行 Rust，76 个文件）
> 目标项目：`D:\programing\CloverViewer-Tauri`（Tauri 2 + Vite + TypeScript vanilla）

## 一、为什么迁移 / 什么时候不该迁移

原版 ADR-001（2024）选择 egui 的理由至今仍然成立：纯 Rust、体积小、即时模式适合截图重绘。
迁移到 Tauri 的**真实收益**在于 Web 前端生态：

| 维度 | egui 版（现状） | Tauri 版（目标） |
|---|---|---|
| UI 组件丰富度 | 手写 widgets（toast/modal/settings ~1.2k 行） | HTML/CSS 原生，复杂表单近乎零成本 |
| 网格视图 | 手写布局 | CSS Grid + 虚拟滚动库（大目录体验质变） |
| 文本输入/IME | egui 弱项（截图文字标注受影响） | WebView 原生 IME |
| 二进制/内存 | ~10MB 单文件，低内存 | ~5-8MB + WebView2（Win10/11 系统自带），内存中等 |
| 截图全屏透明覆盖 | egui Viewport 成熟 | wry 透明窗 + 多屏，**已知坑点，最大风险** |
| 开发迭代 | 改 Rust 重编译 | 前端热更新，UI 迭代快 |
| 复用核心逻辑 | — | xcap/OCR/MCP/config 等 Rust 模块原样移植 |

**决策建议**：Tauri 版作为并行实验分支推进，以 Phase 1（查看器）完成为决策点——
若体验明显优于 egui 版，再投入 Phase 2/3（截图与 OCR）；egui 版保持可用不删。

## 二、代码盘点（迁移量估算）

**可直接/小改移植（~5.5k 行，纯 Rust，无 UI 依赖）**
- `model/config.rs`（229 行）→ ✅ 已移植（序列化格式 100% 兼容，共用 config.json）
- `model/image_meta.rs` + `core/image_loader.rs`（~660 行）→ ✅ 已移植扫描部分（rayon 并行 + 尺寸探测）
- `core/hotkeys.rs` + `hotkey_parser.rs`（~435 行）→ 已用 tauri-plugin-global-shortcut 替代骨架
- `os/windows/ocr.rs`（534 行）→ Phase 3 原样移植（COM 调用与 UI 无关）
- `mcp/`（rmcp + axum server）→ Phase 3 原样移植
- `i18n/lang.rs` 数据（580 行）→ Phase 4 转 TS JSON
- `utils/clipboard.rs`、`core/launch.rs` → 对应 phase 移植

**必须重写（~7.4k 行，egui UI → Web）**
- `feature/viewer/`（~1.9k 行）→ Phase 1（网格/单图/预览/属性面板）
- `feature/screenshot/`（~4.5k 行）→ Phase 2（Canvas 2D 重写，最难）
- `ui/widgets/` + `ui/theme.rs`（~1k 行）→ HTML/CSS 天然替代

## 三、分阶段计划

### Phase 0 — 脚手架 + 核心移植 ✅（本次完成）
- Tauri 2 + Vite + TS vanilla（无前端框架，保持轻量）
- 配置系统：与 egui 版共用 `%APPDATA%/CloverViewer/config.json`
- 单实例（二次启动唤起）、托盘（左键显示/右键菜单）、全局热键 Alt+S（占位转发）
- 窗口位置/尺寸持久化、minimize_on_close（关窗隐藏到托盘）
- 图片目录扫描（rayon 并行 + 尺寸探测）、asset protocol 显示、TIFF 解码兜底
- 前端查看器基础：网格视图、单图（滚轮缩放/拖拽平移/适应/100%/双击切换）、键盘导航、属性面板、拖放打开、明暗主题

### Phase 1 — 查看器功能对齐 ✅
- [x] 大目录虚拟滚动（intersection-observer 或虚拟列表库）
- [x] Rust 侧缩略图生成 + LRU 磁盘缓存（egui 版逻辑移植）
- [x] 上一张/下一张预加载（egui 版 preview.rs 逻辑）
- [x] 旋转/翻转、GIF 动图播放确认、EXIF 详细面板（kamadak-exif 移植）
- [x] 右键菜单、Ctrl+滚轮缩放灵敏度（zoom_sensitivity 配置生效）
- [x] 复制图片/复制文件路径到剪贴板（arboard 移植）

### Phase 2 — 截图标注 ✅（wry 透明窗多屏实测可用）
- [x] 全屏透明覆盖窗（多屏虚拟桌面坐标），⚠️ wry 透明窗在部分 Windows 环境需验证
- [x] xcap 屏幕捕获 → 覆盖窗背景
- [x] Canvas 2D 标注：矩形/椭圆/箭头/画笔/文字/马赛克/高亮（shape.rs 逻辑可参照移植）
- [x] 取色器 + 放大镜（magnifier.rs 487 行逻辑移植）
- [x] 选区八向拖拽调整（hit_test.rs / interaction/ 移植）
- [x] 复制到剪贴板 / 保存文件，Esc 取消，复制热键动态注册
- [x] 取色热键 config 化（settings 可改，默认 Alt+C，与后端 HotkeysConfig 联动）

### Phase 3 — OCR + MCP ✅
- [x] Windows UWP OCR（os/windows/ocr.rs 基本原样移植，加 2× 最近邻放大 + 灰度预处理——Xiangxu 项目已验证的方案）
- [x] OCR 结果面板（前端 Web UI 实现，比 egui 版更容易）
- [x] rmcp stdio/HTTP server 移植（--mcp / --mcp-http 参数）

### Phase 4 — 收尾 ✅（0.1.0 发布形态达成）
- [x] i18n 三语言（lang.rs 数据转 TS）
- [x] 设置界面（egui 版 481 行 settings.rs → HTML 表单）
- [x] 开机自启（launch.rs 移植）、GSV 文字提示框
- [x] NSIS 打包 + 图标，与 egui 版产物对比体积/内存（安装包 2.8MB，currentUser 免 UAC，三语言安装界面）

## 四、构建命令

```bash
cd D:\programing\CloverViewer-Tauri
npm install            # 首次
npm run tauri dev      # 开发（前端热更新）
npm run tauri build    # 发布构建（NSIS 安装包）
cargo check            # 仅检查 Rust 端（在 src-tauri 下）
```

注意：Tauri 项目**无法离线构建**（首次需拉取 ~500 crates + npm 包），
与 Xiangxu 的 `cargo --offline --locked` 工作流不同；首次构建后可用 `cargo build --offline`。

## 五、已知取舍

1. **TIFF**：WebView 不原生支持，走 Rust 解码→PNG dataURL 兜底（大 TIFF 会慢，Phase 1 缩略图缓存可缓解）
2. **窗口坐标**：egui 版存逻辑像素，Tauri 存物理像素，两版混用时窗口位置可能有偏移（首次迁移后自动纠正）
3. **AVIF**：WebView2 原生支持显示（解码在 Rust 侧探测尺寸已兼容）
