# AGENTS.md

给在本仓库工作的 AI 编码代理（Claude Code / DSH / 其他）的入口说明。人类开发者可直接看 `README.md`。

## 这是什么项目

CloverViewer-Tauri：Windows 图片查看器 + 截图工具，Tauri 2（Rust 后端 + Vite/TypeScript 前端）。

| 位置 | 内容 |
| --- | --- |
| `src-tauri/src/` | Rust 后端：命令、配置、图像、截图、滚动截图、OCR、MCP 服务 |
| `src/` | 前端：页面入口、`viewer/`、`screenshot/`、`ui/` 控制器、三语 `locales/` |
| `docs/` | 架构、发布流程、MCP 指南、行数规范、SEO 清单 |
| `site/` | 静态介绍页（由 `.github/workflows/pages.yml` 发布到 GitHub Pages） |
| `tools/`、`tests/` | 验证脚本与单元测试 |

先读：改代码看 `docs/architecture.md`；**发版看 `docs/release.md`**；改仓库元数据看 `docs/seo.md`。
`docs/mcp-refactor-plan.md` 是带日期的历史计划，不代表当前状态。

## 三条铁律

1. **用户可见文字必须三语同步**：`src/locales/zh-CN.ts` 是键的类型来源，改它必须同时补 `en.ts`、`ja.ts`；
   README 同理，`README.md` / `README.en.md` / `README.ja.md` 的结构与特性条目保持一致。
2. **跨端契约先改 `src/api.ts`**：新增或修改 Tauri 命令、事件载荷、配置字段时，先在该文件加封装与类型，
   再同步 Rust 端（`commands.rs` / `config.rs`），不要在控制器里散落 `invoke("...")`。
3. **按行数与职责边界放代码**：单个业务文件默认不超过 500 有效代码行，超出见
   `docs/code-size-guidelines.md`；新增职责优先新建模块，而不是塞进 `screenshot.ts` / `main.ts`。

## 发布

只有人类明确要求时才发版，且必须逐条执行 `docs/release.md`，不要凭记忆操作：

```powershell
npm run release:check     # 发版前机械预检（CHANGELOG 段落、三语同步、站点一致性、密钥忽略）
```

流程中的三个停点（版本确认 / 推标签前 / 收尾人工项）必须停下来问人。

## 常用命令

```powershell
npm run dev                        # 前端开发服务器
npm run check                      # 格式 + lint + 类型 + 单元测试 + 版本一致性
npm run release:check              # 发版前预检（版本段落、三语同步、站点一致性、密钥忽略）
npm run tauri dev                  # 桌面应用开发模式
npm run tauri build                # 发布构建（NSIS 安装包）
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## 不要做的事

- 不要提交 `.tauri/`（内含更新签名私钥；它已被 `.gitignore` 忽略）。
- 不要强推或移动已发布的标签，不要删除已公开的 Release 或资产（详见 `docs/release.md` 第 10 节）。
- 不要改写 `CHANGELOG.md` 里已发布版本的段落（Release 正文是它的快照）。
- 不要只改中文而不改英文、日文。
- 不要往 `CHANGELOG.md` 写未发布的改动或「未发布」占位：该文件只记录已发布版本，版本段落与
  `package.json` 的版本一起在发版时新增。

## 环境注意

- 仓库按 **LF** 存储：`.gitattributes` 对 `*.ts` / `*.mjs` / `*.json` 声明了 `eol=lf`，否则
  Biome 的 `format:check` 会在 `core.autocrlf=true` 的 Windows 上失败。
- `publish-release.ps1` 必须保存为 **UTF-8 with BOM**：Windows PowerShell 5.1 会按 ANSI 读取无 BOM 文件，
  中文注释会导致解析失败（历史上踩过一次）。
