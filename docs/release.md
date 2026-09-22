# 发布流程（人类与 AI 共用）

本文件是 CloverViewer-Tauri 发版的**唯一流程来源**。人类按它发版，AI（Claude Code / DSH / 其他
编码代理）也必须按它发版 —— 不允许凭对话记忆临时发挥。

配套内容：

- `AGENTS.md`：AI 的入口，规定「发版任务先读本文件」。
- `scripts/release-check.mjs`（`npm run release:check`）：把能机械校验的同步项变成一条命令。
- `docs/seo.md`：仓库元数据（Description / Topics / Social preview）的文案与关键词落位。

---

## 0. 触发条件与角色边界

**只有人明确说「发版 / 发布 vX.Y.Z / 出个新版本」时才开始。** AI 不得因为「攒了不少改动」而自行发版。

| 谁 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| AI | 改版本与文案、跑预检与构建、commit、push `main`、打并推送标签、发布后验证、汇报 | 不得自行决定版本号与发布时机；不得跳过人工项；不得使用 `-MoveExistingTag`；不得删除 Release 或标签 |
| 人 | 确认版本号与主题、GitHub Settings 类设置、Search Console、最终决定撤回或热修 | —— |

**流程中的三个必停点**（AI 必须停下、向人输出待确认内容、得到答复再继续）：

| 停点 | 时机 | 为什么必须停 |
| --- | --- | --- |
| **S1** | 阶段 A 结束、动手改版本号之前/之后立即 | 版本号一旦落成标签就有 Release，选错要付出撤回成本 |
| **S2** | 阶段 E 执行 `publish-release.ps1` **之前** | 这是不可逆动作：推送标签即触发构建与公开 Release |
| **S3** | 阶段 G 结束后 | 人工项（Pages / About / Social preview / GSC）只能人做，AI 要交清单而不是假装做完 |

---

## 1. 发布模型与不变量

| 项 | 规则 | 谁保证 |
| --- | --- | --- |
| 版本号唯一来源 | `package.json` 的 `version` | `npm run version:sync` 会写 `package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`；`src-tauri/tauri.conf.json` 引用 `"../package.json"` |
| 标签 | `v<package.json version>`，例如 `v0.1.10` | `release.yml` 会校验标签与清单版本一致，不一致直接失败 |
| Release 正文 | `CHANGELOG.md` 里 `## v<版本>` 段落（到下一个 `## ` 为止） | `release.yml` 抽取；抽不到会退化成一句兜底文案，所以 `release-check` 会拦 |
| 发布产物 | `CloverViewer_x.y.z_x64-setup.exe`（NSIS，per-user）、其 `.sig`、`latest.json` | `tauri.conf.json` 的 `createUpdaterArtifacts: true` |
| 自动更新链路 | 客户端读 `https://github.com/smallclover/CloverViewer-Tauri/releases/latest/download/latest.json`，用内置公钥验签后安装 | 公钥在 `tauri.conf.json`，**私钥只在 GitHub Secret 与离线备份里** |
| 更新检查时机 | 仅用户在「设置 → 软件更新」点「检查更新」时（自 v0.1.8 起） | 因此客户端不会自动拿到新版本，发布公告要人来做 |

> 私钥（`.tauri/cloverviewer.key`，已被 `.gitignore` 忽略）一旦遗失，已发布的客户端将永远无法
> 信任新包 —— 这是整个流程中唯一不可挽回的错误。发布前确认离线备份可用。

---

## 2. 阶段 A：版本与文案准备

1. **定版本号**：按语义化版本。`0.x` 阶段以功能新增为主时进位 minor，纯修复进位 patch。
2. **改 `package.json` 的 `version`**，然后同步派生文件：

   ```powershell
   npm run version:sync
   ```

3. **在 CHANGELOG 顶部新增版本段落**：`## vX.Y.Z — <主题>`。
   - CHANGELOG **只记录已发布版本**：未发布的改动不进这里，也不写「未发布」占位；改动内容以 git 历史为准。
   - 段落内按 `### 新增` / `### 改进与修复` / `### 说明` / `### 文档` 分小节（这些小节会原样成为 Release 正文）。
4. **同步用户可见文档**（按改动性质选择，但**只要动了用户可见文字就必须三语同步**）：

   | 改动性质 | 必须同步的位置 |
   | --- | --- |
   | 新增/变更功能、快捷键 | `README.md` / `README.en.md` / `README.ja.md` 的特性、快捷键、FAQ |
   | 新增设置项、菜单、命令 | `docs/architecture.md`（目录职责与跨端契约） |
   | 新增 MCP 工具或参数 | `README.*` 的 MCP 小节、`docs/mcp-guide.md` 工具表 |
   | 用户可见的站点内容变化 | `site/index.html` 卡片与 `featureList`、`site/sitemap.xml` 的 `<lastmod>` |
   | 模块拆分、文件规模明显变化 | `docs/code-size-guidelines.md` 的当前基线 |

5. **跑一次预检**（此时还没提交，也可以跑）：

   ```powershell
   npm run release:check
   ```

**→ 停点 S1**：向人汇报「准备发布 vX.Y.Z，主题：____，用户可见变化摘要：____」，等确认。

---

## 3. 阶段 B：机械预检（阻塞项必须清零）

```powershell
npm run release:check        # CHANGELOG 段落、三语同步、介绍页/sitemap 一致性、密钥忽略
npm run version:sync         # 确保派生版本文件已同步（幂等）
npm run check                # 格式 / lint / 类型 / 单元测试 / 版本一致性
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

通过标准：全部退出码 0。`release:check` 的 `[WARN]` 需要人判断（例如 sitemap 的 `lastmod`
不是今天就属于提示项，取决于本次是否改了介绍页内容）。

失败处理：`release:check` 的每个 `[FAIL]` 都带「修复」提示，照做即可；**不要**为了让它通过
而删除检查项。

---

## 4. 阶段 C：构建与冒烟

```powershell
npm run tauri build
```

产物：

```text
src-tauri/target/release/cloverviewer-tauri.exe
src-tauri/target/release/bundle/nsis/CloverViewer_x.y.z_x64-setup.exe
```

最小冒烟（用 `cloverviewer-tauri.exe` 或刚装的安装包各走一遍）：

- [ ] 启动主窗口，标题栏三个菜单（文件 / 编辑 / 帮助）能展开、点空白与 Esc 能收起
- [ ] 「编辑 → 设置」能搜索设置项、切分类，改语言三语即时生效
- [ ] 设置 → 缓存：显示占用、能「立即清理」
- [ ] `Alt+S` 截图 → 标注 → Enter 复制
- [ ] `Alt+Shift+S` 长截图框选 → 手动滚动 → 生成结果并能「在查看器中打开」
- [ ] 关于页版本号与本次版本一致

> 网络受限时 NSIS 工具链首次下载可能卡住，处理办法见 README 的镜像说明。

---

## 5. 阶段 D：提交与推送

```powershell
git status                  # 必须干净（publish-release.ps1 会强制要求）
git add -A
git commit -m "release: 0.1.10"
git push origin main
```

- 提交信息沿用仓库既有风格：`release: <版本号>`。
- **只推 `main`，不要提前推标签** —— 标签由阶段 E 一次性推送。

---

## 6. 阶段 E：打标签并发布

**→ 停点 S2**：先向人确认「即将推送标签 `vX.Y.Z` 并触发公开 Release，确认继续？」。

```powershell
./publish-release.ps1 -Tag vX.Y.Z
```

脚本已内建的保护（顺序即执行顺序）：

1. 标签格式、`package.json` / `tauri.conf.json` / `Cargo.toml` 版本一致、标签等于 `v<清单版本>`；
2. `npm run release:check` 机械预检（有阻塞项即中止）；
3. 工作区必须干净、远端可达；
4. 本地/远端同名标签若指向其他提交则报错退出；
5. 先推 `main`，再推标签。

**不要用**：

- `-MoveExistingTag`：已发布的标签被移动后，`releases/latest` 与用户已装的版本会错位。
- `-PruneTags`：会删除历史标签（Release 本身不受影响，但历史追溯会断），除非明确要求清理。

推送后 `release` 工作流会自动构建并创建 Release（约几分钟）。进度：
`https://github.com/smallclover/CloverViewer-Tauri/actions`。

---

## 7. 阶段 F：发布后验证（AI 必须逐条做完再进入 G）

| # | 检查 | 通过标准 |
| --- | --- | --- |
| F1 | Actions 的 `release` 运行 | 绿色；`Verify release version` 与 `Extract release notes` 两步无警告 |
| F2 | Release 页面正文 | 与 `CHANGELOG.md` 的 `## vX.Y.Z` 段落一致，**不是**兜底文案 |
| F3 | Release 资产 | 有 `CloverViewer_x.y.z_x64-setup.exe`、对应 `.sig`、`latest.json` |
| F4 | `latest.json` 内容 | `version` == `X.Y.Z`，下载 URL 指向本次安装包 |
| F5 | Pages 工作流 | 绿色（本次若改了 `site/**`）；首页、`robots.txt`、`sitemap.xml` 均 200 |
| F6 | 端到端自动更新 | 装上一版 → 「设置 → 软件更新 → 检查更新」→ 出现新版本说明 → 下载安装 → 重启后版本为新版 |
| F7 | 安装包名称与 publisher | 文件名格式正确，安装界面语言可选（简中 / English / 日本語） |

F4 可直接用 GitHub API 读取（公开仓库无需 token）：

```powershell
(Invoke-RestMethod https://api.github.com/repos/smallclover/CloverViewer-Tauri/releases/latest).assets | Select-Object name, size
Invoke-RestMethod https://github.com/smallclover/CloverViewer-Tauri/releases/latest/download/latest.json
```

任一检查失败：**不要**继续阶段 G，先按第 10 节处理。

---

## 8. 阶段 G：收尾

1. 若本次改了介绍页，确认 `site/sitemap.xml` 的 `<lastmod>` 已是发布当天，并等 Pages 工作流跑完。
2. 提交收尾改动（如站点 `lastmod`、发布公告用到的文档修正）。
3. 不要往 CHANGELOG 里加任何「下一版占位」：下一个版本的段落等真正发布时再写。

**→ 停点 S3**：输出下面这份清单交给人，等其逐条确认。

```text
需要人工完成（AI 无法代做，详细步骤见 docs/seo.md）：
[ ] Settings → Pages → Source = GitHub Actions
[ ] 仓库首页 About → 齿轮：Description 填 ____；Website 填 https://smallclover.github.io/CloverViewer-Tauri/
[ ] 同一弹窗 Topics：20 个（文案见 docs/seo.md 1.3）
[ ] Settings → General → Social preview：上传 site/og-image.png
[ ] Search Console：Sitemaps 提交 sitemap.xml；网址检查 → 请求编入索引（可选）
```

本次发布汇报模板：

```text
已发布：vX.Y.Z（主题）
标签：vX.Y.Z，提交：<short sha>
验证：F1–F7 结果（逐条）
跳过/异常：____
仍需人做：S3 清单中的 ____
```

---

## 9. 人工专属清单（AI 到此必须停下）

这些是 GitHub/Google 侧设置，仓库文件无法表达；完整文案与理由见 `docs/seo.md`。

| # | 位置 | 要做的动作 | 为什么 |
| --- | --- | --- | --- |
| 1 | Settings → Pages | Source 选 **GitHub Actions** | 不开则介绍页、canonical、sitemap 全是死链 |
| 2 | 仓库首页 About → 齿轮 | Description / Website / Topics 按 `docs/seo.md` 1.1–1.3 填 | 决定站内搜索、推荐与结果摘要 |
| 3 | Settings → General → Social preview | 上传 `site/og-image.png` | 决定分享链接的缩略图与点击率 |
| 4 | Search Console / Bing | 验证站点、提交 `sitemap.xml`、请求编入索引 | 从「等几周」变成「几天」，并可看关键词数据 |
| 5 | 发布前最终确认 | 版本号与 CHANGELOG 主题是否符合预期 | 标签一经推送即公开，撤回成本高 |

第 1、3 项只需做一次；第 2 项在定位或关键词变化时更新；第 4 项每次发版可顺手重抓一次。

---

## 10. 失败与回滚

| 情况 | 处理 |
| --- | --- |
| 阶段 B 预检失败 | 按 `release-check.mjs` 输出的「修复」逐条修；**不要**注释掉检查或删检查项 |
| 阶段 C 构建失败 | 视为阻塞：修代码后再从阶段 B 重跑。NSIS 下载卡住见 README 的镜像章节 |
| Actions 构建失败 | 看 `release` 工作流日志：版本不一致 → 改清单版本并重新提交后**移动标签**（此时 Release 尚未产生，可用 `-MoveExistingTag`）；签名失败 → 检查 `TAURI_SIGNING_PRIVATE_KEY` Secret |
| Release 正文是兜底文案 | 说明 CHANGELOG 段落没被抽到（标题格式或版本号不符）。改 CHANGELOG → 提交 → 移动标签重发（Release 已存在时先在网页补正文） |
| `latest.json` 缺失或版本不对 | `createUpdaterArtifacts` 或签名配置问题，会导致**所有客户端更新检查失败**，优先修复并重发 |
| 标签打错（如 v0.1.91） | 若 Release 未产生：删标签重推正确标签。若已产生：删 Release 与标签，再发正确版本；**先确认没有用户装过** |
| 发布后立刻发现严重 bug | 分两类：<br>① **已推送到客户端之前**（Release 刚创建、无人安装）：可删 Release 与标签回到上一版；<br>② **已可能被安装**：**不要**撤回，直接发 `vX.Y.Z+1` 修复 —— 自动更新只会向上，撤回无法把用户降级 |
| 私钥丢失 | 无法挽回：现有客户端再也无法信任新包。只能让用户手动下载安装新签名密钥构建的版本（需公告） |

**绝对不要做的事**：强推已发布的标签、在 Release 已公开后删除资产、把 `.tauri/cloverviewer.key`
提交到仓库、把 token 写进任何文档或日志。

---

## 11. 完成定义（DoD）

- [ ] `package.json` 版本 = 标签 = CHANGELOG 段落版本
- [ ] `npm run release:check` 阻塞项为 0
- [ ] `npm run check` 与三条 cargo 门禁全绿
- [ ] 构建产物与冒烟清单通过
- [ ] AI 在 S1 / S2 / S3 三个停点都向人确认过
- [ ] F1–F7 逐条验证并汇报
- [ ] CHANGELOG 只有已发布版本段落，没有「下一版占位」
- [ ] S3 人工项清单已交付给人

---

## 12. 附：命令速查与并发给 AI 的提示词

```powershell
# 一、准备
#   改 package.json version + CHANGELOG 段落 + 三语文案 + site/sitemap.xml lastmod
npm run version:sync
npm run release:check

# 二、预检与构建
npm run check
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri build

# 三、提交推送
git add -A; git commit -m "release: X.Y.Z"; git push origin main

# 四、发布（不可逆，先向人确认）
./publish-release.ps1 -Tag vX.Y.Z

# 五、验证（见第 7 节 F1–F7），然后确认站点 lastmod 并交付 S3 人工清单
```

交给 AI 的提示词模板：

```text
请按仓库的 docs/release.md 发布 vX.Y.Z（主题：____）。
要求：严格执行阶段 A–G，三个停点（S1/S2/S3）必须停下来问我；
不要使用 -MoveExistingTag，不要删除 Release 或标签；
结束时按文档里的汇报模板给我结果，并附上 S3 的人工待办清单。
```
