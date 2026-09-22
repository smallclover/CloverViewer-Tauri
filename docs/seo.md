# SEO 与仓库元数据清单

本文件说明 CloverViewer-Tauri 的可发现性（discoverability）优化：仓库内已经落地了什么、
哪些只能在 GitHub 网页设置里手动完成、以及每次发版要顺手维护什么。

目标关键词围绕「免费开源的 Windows 图片查看器 / 截图工具 / 滚动长截图 / OCR 取字 /
面向 AI 的 MCP 截图服务」这几类真实搜索意图，不做关键词堆砌。

---

## 1. 需要手动完成的仓库设置

仓库 Description、Topics、Social preview 和 Pages 开关都是 GitHub 侧的元数据，无法通过提交文件修改。

### 1.1 Description（Settings → General → Description）

建议（中文，默认展示，约 110 字符）：

```text
免费开源的 Windows 图片查看器 + 截图工具：多屏截图标注、滚动长截图、OCR 取字、内置 MCP Server（Tauri 2）
```

英文备选（面向英文搜索时使用）：

```text
Free, open-source Windows image viewer & screenshot tool: annotated multi-monitor capture, scrolling (long) screenshots, OCR and a built-in MCP server for AI clients. Built with Tauri 2.
```

要点：把「Windows」「图片查看器 / image viewer」「截图 / screenshot」「开源 / open source」
放在最前面，GitHub 搜索和 Google 摘要都会优先截取开头部分。

### 1.2 Website（同一页面）

```text
https://smallclover.github.io/CloverViewer-Tauri/
```

### 1.3 Topics（同一页面，建议 20 个）

```text
image-viewer  screenshot  screenshot-tool  scrolling-screenshot  long-screenshot
screen-capture  annotation  ocr  windows  desktop-app
tauri  tauri2  rust  typescript  mcp
model-context-protocol  claude-desktop  portable-app  mit-license  image-processing
```

Topics 是 GitHub 站内搜索与「Related repositories」的主要依据，也常被第三方 Awesome 列表抓取。

### 1.4 Social preview（Settings → General → Social preview）

上传 `site/og-image.png`（1200×630，仓库内已生成）。它决定链接在 Twitter/X、Slack、
Discord、微信等处的预览图，直接影响点击率。

### 1.5 GitHub Pages（Settings → Pages）

- Source 选择 **GitHub Actions**（不要选 “Deploy from a branch”）。
- 推送 `site/**` 的改动后，`.github/workflows/pages.yml` 会自动发布静态介绍页。
- 首次发布后确认这三个地址可访问：
  - `https://smallclover.github.io/CloverViewer-Tauri/`
  - `https://smallclover.github.io/CloverViewer-Tauri/robots.txt`
  - `https://smallclover.github.io/CloverViewer-Tauri/sitemap.xml`

### 1.6 搜索引擎站长工具（可选，建议做一次）

在 Google Search Console / Bing Webmaster Tools 添加上述 Pages 地址并提交 sitemap。
需要域名验证文件时，把 HTML 验证文件放进 `site/` 目录再推送即可（不要在 Pages 里启用 Jekyll 处理，Actions 部署不经过 Jekyll）。

---

## 2. 仓库内已落地的优化

| 位置 | 内容 |
| --- | --- |
| `README.md` / `README.en.md` / `README.ja.md` | 标题与摘要含主关键词；新增「适合谁用 / Who It Is For / こんな用途に」匹配搜索意图；FAQ 覆盖常见长尾问题；「文档」表格形成内链；补全图片 `alt`；语言切换链接修复（原先 HTML 块内的 Markdown 链接不会渲染） |
| `site/index.html` | 独立可索引介绍页：`<title>`、meta description、canonical、Open Graph / Twitter Card、JSON-LD `SoftwareApplication` + `FAQPage`、面向屏幕阅读器的跳转链接、中英双语内容 |
| `site/styles.css` | 单文件样式，无外部字体与第三方脚本（不引入跟踪、不拖慢 LCP） |
| `site/robots.txt` / `site/sitemap.xml` | 允许抓取并声明 sitemap；发版时更新 `lastmod` |
| `site/og-image.png` | 1200×630 分享预览图，同时用作社交预览与结构化数据配图 |
| `.github/workflows/pages.yml` | 推送 `site/**` 自动发布 Pages |
| `CHANGELOG.md` | Release 正文来源（见下），每个版本段落都能被搜索引擎收录为独立内容 |

结构化数据里刻意**没有**写 `softwareVersion`：避免发版后页面与真实版本不一致。如果需要，
可在每次发版时补上，但必须与 `package.json` 同步。

---

## 3. 关键词 → 落位映射

| 搜索意图 | 主要落位 |
| --- | --- |
| windows 图片查看器 / 看图软件 开源 | README H1、落地页 H1、Description、Topics |
| 免费 截图工具 / 截图 标注 | README「截图与标注」、落地页卡片、FAQ |
| 滚动截图 / 长截图 / 网页长截图 | README 特性、落地页 `#scroll-capture` 小节、`docs/scroll-capture-v2.md` |
| 截图 OCR / 图片文字识别 | README 特性、落地页卡片、FAQ |
| MCP server 截图 / 让 AI 看屏幕 | README MCP 小节、落地页卡片、`docs/mcp-guide.md` |
| Tauri 2 桌面应用示例 / Rust 截图 | README 技术栈、落地页英文段落、Topics |

---

## 4. 每次发版的维护清单

> 发版流程的权威版本是 [发布流程](release.md)（含版本准备、预检、构建、发布、验证与回滚，
> 以及 AI 必须停下的三个停点）。这里只列与可发现性相关的部分。

1. `CHANGELOG.md`：为本次版本新增 `## vX.Y.Z — 标题` 段落（发布流水线按 `## v<版本号>` 抽取 Release 正文；抽不到会回退成兜底文案）。该文件只记录已发布版本，平时不写未发布内容。
2. Release 正文第一行写清版本主题与关键词，正文保留用户可见变化，不要只写 commit 列表。
3. `site/sitemap.xml`：更新 `<lastmod>`；有功能变化时同步落地页文案与 FAQ。
4. `site/index.html`：如果新增了用户可见能力（例如新的 MCP 工具、新格式），同步卡片与 `featureList`。
5. 三份 README：功能有增删时同步「功能特性」「快捷键」「FAQ」，不要只改中文。
6. 推送后确认 Pages 工作流成功，并在 Search Console 里对首页请求一次重新抓取。

---

## 5. 不要做的事

- 不要在 README 或落地页堆砌关键词列表：GitHub 与 Google 都会判定为低质量内容。
- 不要写无法验证的对比或数据（下载量、用户数、速度倍数）。
- 不要用多个入口页承载同一份文案：落地页是概览并链回 README，README 是完整说明，两者措辞不同。
- 不要把 token、私钥或内网地址写进任何面向公众的文档。
