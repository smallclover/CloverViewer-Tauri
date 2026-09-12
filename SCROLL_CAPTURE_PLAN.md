# 滚动截图（长截图）设计方案

> 状态：**P0 技术验证 + P1 MVP + P2 入口重构均已落地**（本文件保留为设计依据与踩坑记录）
> 落地版本：**v0.1.2**（`src-tauri/src/scroll_capture.rs` + `src/screenshot.ts` 滚动截图一节）
> 后续计划：P3 长图标注（视图变换）、P4 手动滚动/横向/MCP 工具，详见第 9 节
> 相关文档：[README.md](./README.md) · [ROADMAP.md](./ROADMAP.md) · [CHANGELOG.md](./CHANGELOG.md)

---

## 0. TL;DR

给截图模块加一个「滚动截图」工具，用户框选一块可滚动区域后，程序**自动发滚轮把内容滚下去**，逐帧捕获、按重叠像素拼接成一张长图，最后走现有的「复制 / 保存 / 标注」出口。

核心结论（后面各节展开）：

1. **算法抄 ShareX 的思路，不抄代码**（ShareX 是 GPLv3，本项目 MIT）：逐行匹配找重叠、忽略左右侧边（躲滚动条）、忽略底部固定条（躲吸底工具栏）、匹配失败时降级为「部分成功」而不是直接失败。
2. **拼接全部在 Rust 侧做**，用 RGBA 内存缓冲，**绝不走现有的 PNG + base64 IPC 路径**——4K 屏单帧 PNG 编码要几百毫秒（`screenshot.rs` 里已有注释记录），滚动 20 帧就是几秒纯编码开销，必须绕开，只在最后编码一次。
3. **捕获期间不隐藏覆盖窗**：把选区内的画布清空（覆盖窗是 `transparent(true)`，透明像素会透出真实桌面），用户能实时看到目标窗口被真实滚动，且不闪屏；进度 HUD / 缩略预览一律画在**选区之外**，不污染捕获。
4. **滚轮注入用 `PostMessage(WM_MOUSEWHEEL)` 到 `WindowFromPoint` 的深层子窗口为主**（不依赖焦点、不需要把覆盖窗变 click-through、用户误点也不会打断），失败再降级 `SendInput` / `WM_VSCROLL` / `PageDown`，并在开始前做「滚动探针」预检。
5. 分 5 个阶段落地：**P0 技术验证（✅ 已完成，见附录 A）→ P1 可用 MVP（2-3 天）→ P2 预览与设置 → P3 长图标注 → P4 手动滚动/横向/MCP**。MVP 到「自动滚动 + 拼接 + 保存/复制/打开查看器」。
6. **P0 实测结论已回灌本方案**（附录 A）：没有任何单一滚动注入方式能通吃所有应用（资源管理器不吃 `wheel_post`，Chrome 全吃）；Chrome 平滑滚动要 ≈1.1s 才稳定，所以「稳定帧等待」是必需品而非优化；`WM_VSCROLL`/`PageDown` 必须发给子窗口；周期性内容会让朴素位移估计失效。

---

## 1. 目标与范围

### 1.1 要做

| 能力 | 说明 |
|---|---|
| 自动滚动捕获 | 框选区域 → 程序发滚轮 → 自动滚到底并拼接 |
| 智能拼接 | 自动识别重叠、自动跳过吸顶标题栏/吸底工具栏/滚动条/侧边栏 |
| 实时反馈 | 捕获中显示进度（已捕获高度、帧数）、缩略预览、匹配是否成功 |
| 随时停止 | Esc / HUD 停止按钮，停止后**保留已捕获部分**（部分成功） |
| 结果出口 | 复制到剪贴板 / 保存到桌面 / 在查看器中打开 / （P3）长图标注 |
| 可配置 | 每次滚动格数、帧间延迟、回顶策略、最大高度、自动裁剪吸底等 |
| MCP（P4） | 新工具 `capture_scrolling_window`，对齐项目「内置 MCP」的差异化卖点 |

### 1.2 不做（非目标）

- **不做浏览器扩展式 DOM 截图**（`Page.captureScreenshot` / CDP）：只覆盖浏览器，且与本项目的桌面截图定位不符。
- **不保证 100% 成功率**：滚动截图本质上依赖目标应用的渲染稳定性，PixPin / ShareX 的成功率也不是 100%，我们的目标是**失败时给得出原因，且已捕获部分不丢**。
- **P1 不做横向滚动截图**：算法是对称的（转置即可），但先纵向验证透。
- **不引入 WGC（Windows.Graphics.Capture）**：留作 P4 的「窗口捕获后端」增强，见 4.2。

---

## 2. 市面方案调研

| 产品 | 驱动方式 | 捕获方式 | 拼接 | 亮点 / 短板 |
|---|---|---|---|---|
| **ShareX**（开源，GPLv3） | 自动：`SendInput` 滚轮 / Down / PageDown / `WM_VSCROLL` | 屏幕区域 `CaptureRectangle` | **逐行 `memcmp` 精确匹配** + 忽略左右侧边 + 自动忽略底部固定条 + best-guess 降级 | 算法最完整、参数最全（`ScrollingCaptureOptions`）；对动态内容敏感；UI 朴素 |
| **PixPin** | **手动：用户自己滚**（也支持自动） | 屏幕区域 | 智能拼接，实时缩略预览 + **匹配状态指示（绿色=匹配成功）** | 交互最好：可随时调选区大小/移动选区、上下裁剪、自动裁剪（VIP）；官方文档明确列了失败场景（动态内容、固定侧边栏、滚动条、纯色/重复排版、滚动过快） |
| **Snipaste** | 自动 | 屏幕区域 | 重叠匹配 | 口碑好但长截图对部分应用兼容性一般 |
| **Windows 11 截图工具** | 自动 | 屏幕区域 | 内置 | 兼容性差，只对部分应用有效 |
| **浏览器扩展**（GoFullPage 等） | DOM/滚动 API | `captureVisibleTab` | 已知 scrollHeight，无需匹配 | 只覆盖浏览器；不受桌面应用约束 |

### 2.1 ShareX 的关键算法（我们重点参考）

从 `ScrollingCaptureManager.cs` 读到的要点：

- 捕获循环：`截一帧 → 与上一帧比对（完全相同=到底）→ 发滚动 → 拼接 → 延迟`。
- `Options.AutoScrollTop`：开始时先 `Ctrl+Home` + `WM_VSCROLL SB_TOP` 回到顶部。
- 拼接 `CombineImages`：
  - **忽略左右各 `max(50, width/20)` 像素**（避开滚动条、侧边栏像素差）。
  - **自动忽略底部固定条**：从最后一行的上一行开始，用 `memcmp` 找「结果图最后 N 行 == 当前帧最后 N 行」的最大 N，把这块排除掉——于是吸底工具栏只会出现在最终图的最底部，不会被烤进中间。
  - 匹配：从当前帧底行向上遍历，对每个候选 y 数「向上连续相同的行数」，取最长者；匹配长度上限 `H/2` 控制耗时。
  - 新图高度 = `结果高 - 忽略底部 + 新增行数`。
  - 匹配失败但之前有成功记录 → 用上次的 offset 作为 best guess，状态标为 `PartiallySuccessful`。
- 叠加优化：可选用 `GetScrollInfo(SB_VERT)` 的 `nMax/nPos/nPage` 精确判断到底（只对有标准滚动条的窗口有效）。

### 2.2 PixPin 的关键交互

- **手动滚动**为主：用户自己滚，程序只负责识别与拼接——**这是对「滚轮注入无效」的应用最有效的兜底**。
- 实时**缩略预览** + 「当前画面在长图中的位置」绿色匹配指示。
- 选区在捕获中可以调整/移动（自动裁剪是 VIP 功能）。
- 官方明确提醒的坑：动态内容、选区含固定侧边栏、含滚动条、纯色/重复排版区域、滚动过快。**我们的错误提示文案可以照这个清单写。**

### 2.3 结论

- **抄思路**：ShareX 的「逐行重叠匹配 + 忽略侧边 + 忽略吸底 + best-guess 降级」几乎是被验证过的最简可行算法；PixPin 的「实时预览 + 匹配状态 + 手动滚动兜底」是被验证过的最好交互。
- **不抄代码**：ShareX 为 GPLv3，本项目 MIT，**只参考算法描述自行实现**，不复制任何源码。
- **改进点**（相对 ShareX）：用「稳定帧等待（settle）」替代固定 `ScrollDelay`，对慢渲染页面更稳；用「行指纹 + 全分辨率复核」替代朴素两重循环，把最坏 O(H²·W) 降到近似 O(H·W)；捕获期间保持覆盖窗可见，用户不闪屏。

---

## 3. 现状与约束（本仓库）

必须先认清的既有设计，方案是围绕它们设计的：

| 现状 | 约束/影响 |
|---|---|
| 截图覆盖窗 = 独立透明置顶窗 `screenshot`，尺寸 = 虚拟桌面包围盒，已按 `min_x/min_y` 定位并补偿 DWM 边框偏移（`screenshot.rs: start_screenshot`） | 滚动捕获期间**不能销毁/重建**它（WebView2 冷启动 200-500ms），保持可见并清干净选区像素即可 |
| 覆盖窗是 `transparent(true)`，`body` 透明，只有画布内容不透明 | 选区清空后，**穿透看到的是真实桌面/真实目标窗口**，屏幕捕获拿到的就是真实像素，不会自捕获 |
| 前端所有图形数据 = **物理像素**，`physPos()` 把鼠标 CSS 坐标直接换算成物理坐标，**没有 zoom/pan 变换** | 长图（如 1200×12000）无法 1:1 放进屏幕大小的窗口 → **P3 需要引入视图变换**（见 6.3） |
| Rust 侧截图后把 PNG 编码成 base64 data URL 塞进 `ScreenshotData.screens[]`，前端 `<img>` 解码后当像素源 | **单帧编码几百 ms**，滚动捕获 20+ 帧绝不能走这条路；捕获循环里保持 RGBA 内存，只在最后 `encode` 一次 |
| `pick_window_at(x, y)` 已实现「Z 序枚举顶层窗口 + DWM 扩展帧边界 + 跳过自身窗口」 | 直接复用/扩展为「找滚动目标窗口」，需要再加「取深层子窗口」的 `WindowFromPoint` |
| `capturing` 互斥锁 + `screenshot-refresh` / `screenshot-clear` 事件 | 滚动捕获期间要占用同一互斥量，避免 Alt+S 打断 |
| `xcap` 0.9.8：`Monitor::capture_image()` = 桌面 DC `BitBlt`（整屏）；`Window::capture_image()` = `PrintWindow(PW_RENDERFULLCONTENT)` | 提供了两个后端：屏幕区域（需裁剪）与窗口捕获（不受遮挡），见 4.2 |
| `windows` crate 0.62 已是直接依赖（`features` 里只有 `Media_Ocr / Graphics_Imaging / ... / Win32_UI_WindowsAndMessaging / Win32_Graphics_Dwm`） | 需要**追加 features**：`Win32_Graphics_Gdi`（BitBlt 区域捕获）、`Win32_UI_Input_KeyboardAndMouse`（SendInput/SetCursorPos） |

---

## 4. 总体设计

### 4.1 数据流

```
[screenshot 覆盖窗 · 前端]
  框选滚动区域 ──▶ start_scroll_capture(req)          ┌──────────── Rust: scroll_capture.rs ────────────┐
                                                       │ 1. 解析目标窗口 (WindowFromPoint → root HWND)     │
  ◀── event: scroll-capture-progress {frame, height,    │ 2. 滚动探针（1 格 → 像素是否变化）                 │
      strip_preview, status} ──────────────────────────│ 3. 可选回顶（滚轮向上 ×N）                        │
                                                       │ loop:                                            │
  ◀── event: scroll-capture-done {ok, width, height,   │   捕获选区 RGBA → 稳定帧等待(settle)              │
      frames, confidence, data_url?} ──────────────────│   与上一帧比对：相同 → 到底 → break               │
                                                       │   行指纹找重叠 → 全分辨率复核 → 追加到累积缓冲     │
  Esc / 停止 ──▶ stop_scroll_capture()                  │   注入滚动（PostMessage / SendInput / VSCROLL）    │
                                                       │ 4. 编码一次 PNG → 保存/剪贴板/回传前端            │
                                                       └──────────────────────────────────────────────────┘
```

### 4.2 捕获后端

| 后端 | 实现 | 优点 | 缺点 |
|---|---|---|---|
| **A. 屏幕区域（默认）** | 自写 `BitBlt` 区域捕获（`GetWindowDC(GetDesktopWindow())` + `BitBlt(dest,0,0,w,h,src,x,y,SRCCOPY)`），或 `Monitor::capture_image()` 后 `crop_imm` | 与现有 Alt+S 截图完全同源，像素精确；选区不要求等于某个窗口 | 目标窗口被第三方窗口遮挡时会截到遮挡内容；覆盖窗在选区内必须保持全透明 |
| **B. 窗口捕获（可选/回退）** | `xcap::Window::capture_image()`（内部 `PrintWindow(PW_RENDERFULLCONTENT)`）取目标窗口，再按 client rect 裁剪 | **不怕遮挡**，覆盖窗可以照常显示任何东西，理论上还能做到「不闪不跳」的连续预览 | 部分应用（硬件加速视频、部分游戏/Electron）返回黑图或失败；比 BitBlt 慢且是同步调用，目标应用忙时会卡 |

**决策**：P1 只做后端 A；`capture_backend: "screen" | "window"` 写进配置，后端 B 在 P4 作为「遮挡场景」选项补齐，接口先预留。

### 4.3 滚动注入（四选一 + 自动降级）

| 方式 | 实现 | 适用 |
|---|---|---|
| **① `PostMessage(WM_MOUSEWHEEL)`（默认首选）** | `WindowFromPoint(region center)` → 逐层 `ChildWindowFromPointEx` 取最深层子窗口 → `PostMessage(hwnd, WM_MOUSEWHEEL, (delta<<16)|0, MAKELPARAM(screenX, screenY))` | 不依赖焦点、不需要覆盖窗 click-through、可后台工作。**P0 实测：Chrome ✅ ≈125px/格、标准控件（ListBox）✅ +3 行/格；资源管理器 ❌** |
| ② `SendInput(MOUSEEVENTF_WHEEL)` | 临时 `set_ignore_cursor_events(true)` + `SetCursorPos(选区中心)` + `SendInput`，发完**立刻把光标移出选区**（避免悬停高亮污染帧），结束后恢复光标位置 | 兼容性最好：**P0 实测三种目标全 ✅**（含不吃滚轮消息的资源管理器）。依赖系统「悬停滚动非活动窗口」设置（Win10/11 默认开）；覆盖窗此时不拦鼠标 |
| ③ `WM_VSCROLL, SB_LINEDOWN` | **发给最深子窗口**（发给顶层无效，P0 实测） | 只对有标准滚动条的 Win32 控件（ListBox、部分列表）有效；资源管理器/Chrome 均 ❌（Chrome 顶层居然吃，但不值得依赖） |
| ④ `PageDown` / `Down` 键 | `PostMessage(WM_KEYDOWN, VK_NEXT/VK_DOWN)`，**发给最深子窗口**，lParam 带 `MapVirtualKeyW` 扫描码 | 网页、文档、**资源管理器**（P0 实测资源管理器唯一可用的「非模拟滚轮」方式） |

**自动降级顺序（P0 后的结论）**：`wheel_post → SendInput → PageDown → WM_VSCROLL`。没有任何单一方式能通吃，**探针预检是必需的**：

**探针预检**（很重要）：正式循环前——
1. 截一帧 A；
2. 用方式①发 1 格滚轮，`settle` 等待；
3. 截一帧 B，判定「发生了滚动」；
4. 否则依次换 ②③④ 重试（注意 ② 需要覆盖窗临时 click-through + 光标进选区）；
5. 全失败 → 中止并提示「该区域未发生滚动，可能不可滚动（检查：选区是否在可滚动区域、是否包含多个滚动区域）」，同时给出「改用**手动滚动模式**」(P4) 的入口。

> **判据要点（P0 实测）**：不要只用像素 diff。周期性内容（等距同款列表、图标网格）滚动前后 diff 只有 3–8‰，但确实滚了；反之悬停高亮能造成 ~1‰ 的 diff 而根本没滚。
> 推荐判据优先级：**① 子窗口滚动条位置变化（`GetScrollInfo`，最硬）→ ② 连续多步的位移估计一致且误差低 → ③ diff 超阈值（仅作兜底）**。

### 4.4 驱动模式

- **自动（P1 默认）**：程序发滚动。用户只需别动鼠标键盘。
- **手动（P4）**：用户自己滚，程序以 ~12fps 轮询捕获 + 增量拼接。此模式下覆盖窗必须 `set_ignore_cursor_events(true)`（否则滚轮被覆盖窗吃掉），并允许**向上滚**（向上滚 = 从累积结果尾部裁剪，即 PixPin 的「自动裁剪」）。这是对「注入无效」应用的最强兜底。

### 4.5 捕获期间覆盖窗的状态

| 项 | 设置 |
|---|---|
| 窗口可见性 | **保持可见**（不 hide，避免闪屏与 WebView2 重建） |
| 选区像素 | 画布**不绘制**（保持透明 → 透出真实窗口，捕获到的就是真实像素） |
| 选区边框 | 用 UI 层绘制 1px 半透明框 + 四角标记（**画在选区外侧 1px 外扩**，避免吃掉边界像素；参考 ShareX 的 `ScrollingCaptureRegionForm`） |
| HUD | 进度胶囊（帧数 / 已捕获高度 / 匹配状态 / 停止按钮）+ 缩略图，一律放在**选区之外**（优先选区右侧，放不下则左下角，复用现有 `positionHelpBox()` 的避让逻辑） |
| 鼠标 | **跟随注入方式**：用方式①（PostMessage）时保持拦截（用户误点不会打断目标）；退到方式②（SendInput）时必须临时 `set_ignore_cursor_events(true)`，否则滚轮事件被自己的覆盖窗吃掉（P0 结论）。捕获结束立即恢复 |
| 光标 | 方式②下每次发完滚轮**立刻把光标移出选区**再截帧：否则悬停高亮会在每帧同一位置留下 ≈0.1% 的像素差，被拼接误判成固定元素（P0 结论）。移出后再 `settle`，高亮自然消失 |
| 键盘 | 覆盖窗持有焦点 → 现有 `keydown` 处理 Esc 直接可用；不需要临时注册全局 Esc 热键。方式②把光标交给目标窗口不改变键盘焦点，Esc 仍然有效 |
| 焦点 | 开始时可选 `SetForegroundWindow(目标窗口)` + `set_focus(覆盖窗)`：既让目标窗口「像被操作」一样响应，又把键盘焦点留在覆盖窗。**若目标窗口被第三方窗口遮挡（后端 A 捕获的是屏幕像素），必须先把它提到前台**，否则截到的是遮挡窗口 |

> 注意：不要打断覆盖窗里的 `screenshot-clear` / `screenshot-refresh` 流程，滚动会话开始时把 `ScreenshotStore.capturing` 置位即可复用现有互斥。

---

## 5. 拼接算法

### 5.1 预处理

- 全程 **RGBA8 内存缓冲**（`image::RgbaImage` 或裸 `Vec<u8>` + stride），不编码 PNG。
- 每帧捕获后**先做稳定帧等待（settle）**：每 `poll_interval_ms`（默认 60ms）截一帧，与前一帧比较；若 `diff_ratio < 0.001` 视为稳定，最长等 `settle_timeout_ms`（**默认 1500ms**）——P0 实测 Chrome 平滑滚动要 ≈1100ms 才停，默认值必须覆盖它。这比 ShareX 的固定 `ScrollDelay` 更稳（慢渲染页面、懒加载列表都能吃下）。
- 匹配用的灰度图（`luma8`）+ 行指纹在捕获线程里现算即弃，不长期驻留。

### 5.2 重叠匹配

**输入**：上一帧 `prev`（也是当前累积结果的尾部）、当前帧 `cur`，尺寸同为 `W×H`。

**关键参数**（都可配置）：

- `side_margin = clamp(W/20, 50, W/3)`：左右各忽略这么多像素（躲滚动条/侧边栏）。
- `bottom_fixed = auto`：自动探测底部固定条高度（见 5.3）。
- `min_overlap = 24px`（或 `H/10` 取大者）：匹配长度低于此视为失败。
- `min_shift = 4px`：位移小于此说明没滚动 → 提前判定「到底」。
- `max_height_px`（默认 20000）：累积高度上限，超限安全停止。

**步骤**：

1. **行指纹**：对 `cur` 与 `prev` 的每个 y，在 `[side_margin, W-side_margin)` 列区间内按固定步长（默认每 4 列取 1，共 ~200 采样点）计算 64-bit 指纹（如 FNV-1a 或自定义 rolling hash）。
2. **候选位移**：对每个候选 `j`（cur 的行下标），检查「`cur` 自 `j` 向上的连续行指纹」是否与「`prev` 自 `rect_bottom` 向上的连续行指纹」一致（`rect_bottom = prev 高 - 1 - bottom_fixed`），记录最长连续长度 `run[j]`。取 `run` 最大者 → 位移 `shift = (rect_bottom - j)`（即页面被滚动了多少像素）。
   - 复杂度 O(H·W/4)（指纹每行一遍），比朴素 O(H²·W) 好得多。
3. **全分辨率复核**：对最优候选以及次优候选（若分数接近），在 `[side_margin, W-side_margin)` 全域逐行比较：
   - 允许每通道容差 `tol`（默认 2），以吸收极少数非确定性渲染差异；
   - 若最优与次优的匹配长度差 < 15%，判定**歧义**（典型原因：纯色区、大面积重复排版）→ 用第 4 步的位移一致性投票决定，仍不通过则本帧判失败。
4. **位移一致性检查**：连续两次成功匹配的 `shift` 不应出现 >3× 的跳变（滚动是不会加速的）；跳变过大 → 置信度下调为「低」，并在 UI 上把该处标记为黄色。
5. **追加**：把 `cur` 的 `[j+1, H - bottom_fixed)` 行追加到累积缓冲（`prev` 的尾部 `bottom_fixed` 行被丢弃后由本帧重写，于是吸底栏只保留最后一份）。

### 5.3 固定区域处理

| 现象 | 处理 |
|---|---|
| **吸底工具栏/输入框**（微信输入框、聊天 App、固定底部按钮） | 「结果尾部 N 行 == 当前帧尾部 N 行」求最大 N（ShareX 的做法）→ 排除该带并把本帧的这条带重新追加到结果尾部 → 吸底栏只在最终图底部出现一次 |
| **吸顶标题栏/导航栏**（微信群名、网页 sticky 导航） | 因为「追加点 j 位于吸顶带之下」，吸顶带不会进入追加区域，**天然只出现在最终图顶部一次**；额外做一次保护：若 `j < sticky_top_h + min_overlap`（`sticky_top_h` = 「当前帧前 h 行 == 上一帧前 h 行」的最大 h），认为匹配落在了吸顶带内部 → 该候选作废，取次优 |
| **滚动条** | 由 `side_margin` 忽略（左右各 ~5%）。文档/提示里明确建议「选区尽量不要包含滚动条」（PixPin 同款提示） |
| **固定侧边栏/悬浮窗**（部分 App 左栏不动） | 若固定区域在左右边缘 → `side_margin` 覆盖；若在中间 → 无法自动处理，走「歧义/低置信度」路径并在结果里提示「检测到固定区域，可能有错位」 |

### 5.4 结束判定（按优先级）

1. **子窗口滚动条到底**：`GetScrollInfo(SB_VERT)` 查**最深子窗口**（查顶层永远是空），`nPos + nPage - 1 >= nMax` → 到底。**这是最硬的判据，优先用**（P0 实测 ListBox 精确可用；Chrome/资源管理器没有标准滚动条，此路不通）。
2. **连续两帧完全相同**（差异像素占比 < 0.1%，且已重试延迟 2×`settle_timeout`）→ 到底，正常结束。注意周期性内容下「滚动前后也几乎相同」，所以这一条必须配合「本帧位移 < `min_shift`」一起判，不能单用。
3. **本帧位移 < `min_shift`**（且位移估计置信）→ 到底。
4. **达到 `max_frames` / `max_height_px` / 内存上限** → 停止，标记为「部分成功」。
5. 用户 Esc / 点停止 → 停止，保留已有内容。

### 5.5 置信度与降级

每个「追加」都算一个 `confidence = 匹配长度 / 期望重叠长度`，并累计到会话：

- 全部高置信 → 结果页显示「拼接完成（N 帧 / 高 H px）」；
- 出现低置信/歧义帧 → 显示「拼接完成，但第 k 段可能存在错位」+ 允许「重试本次」；
- 连续 2 次匹配完全失败（拿到当前帧都拼不进去）→ 中止，把**已拼接部分**返回（`PartiallySuccessful`），提示排查清单（动态内容 / 固定区域 / 滚动条 / 纯色重复内容 / 滚动过快）。

### 5.6 核心伪代码（Rust）

```rust
// src-tauri/src/scroll_capture.rs（新增）
fn run_session(app: AppHandle, req: ScrollCaptureRequest, cancel: Arc<AtomicBool>) -> Result<Stitched, String> {
    let target = resolve_target_window(&req.region)?;       // WindowFromPoint → root + deepest child
    let method = probe_scroll_method(&req.region, &target)?; // ①→②→③→④ 探针
    if req.auto_scroll_top { scroll_to_top(&target, &req.region, method); }

    let mut canvas: Vec<u8> = Vec::new();   // 累积 RGBA
    let mut canvas_h: u32 = 0;
    let mut prev = capture_settled(&req.region, &req)?;
    append_first(&mut canvas, &mut canvas_h, &prev);
    emit_progress(&app, 1, canvas_h, preview_strip(&prev, req.region.w));

    let mut last_shift = None;
    loop {
        if cancel.load(Ordering::Relaxed) { return Ok(partial(canvas, canvas_h, Confidence::Stopped)); }
        if canvas_h >= req.max_height_px { return Ok(partial(canvas, canvas_h, Confidence::TooLong)); }

        inject_scroll(&target, &req.region, method, req.scroll_amount);
        let cur = capture_settled(&req.region, &req)?;

        if same_frame(&cur, &prev, 0.001) && settles_twice(&req) { break; } // 到底

        match find_vertical_overlap(&prev, &cur, &req.match_params(), last_shift) {
            Match::Shift { shift, bottom_fixed, confidence } if shift >= req.min_shift => {
                append_rows(&mut canvas, &mut canvas_h, &cur, bottom_fixed);
                last_shift = Some(shift);
                emit_progress(&app, frames, canvas_h, preview_strip(&cur, req.region.w));
            }
            _ => { failures += 1; if failures >= 2 { return Ok(partial(...)); } }
        }
        prev = cur;
    }
    Ok(finish(canvas, canvas_h, Confidence::High))
}

/// 纯函数，可单测：给两张同尺寸帧，返回最优纵向位移与底部固定带
pub fn find_vertical_overlap(prev: &RgbaImage, cur: &RgbaImage, p: &MatchParams, last_shift: Option<u32>) -> Match;
```

---

## 6. 交互流程与 UI

### 6.1 用户视角流程（自动模式）

1. `Alt+S` 进入截图 → 工具栏点「**滚动截图**」图标（放在 OCR 按钮之后、分隔线之前）。
2. 光标变成「区域选择」态，**复用现有交互**：悬停时绿框吸住窗口（`pick_window_at`），拖拽可自定义选区。
   - 选中窗口时，默认把**窗口 client 区域**作为候选选区（可再拖拽微调），PixPin 同款。
3. 松手后选区确定，右下角浮出小面板：`[▶ 开始滚动截图] 每次 1 格 ▾ · 延迟 200ms · ☑先回到顶部`（默认值来自配置，面板可折叠）。
4. 点开始（或按 `Enter`）：
   - 覆盖窗清空选区绘制，画上边框 + 半透明遮罩（选区外）；
   - HUD 显示：`已捕获 3 帧 · 1820px · 匹配良好` + 右侧实时缩略图（新追加的条带逐步拼上去）+ `[■ 停止]`；
   - 用户看到目标窗口**真实地一页页往下滚**（因为覆盖窗透过去了）。
5. 到底自动结束 / 用户 Esc。Esc 时保留已捕获部分。
6. 结束态 HUD：`✓ 完成 · 12 帧 · 1240×9860` + `[复制] [保存] [在查看器中打开] [重截]`，`Enter` = 复制、`Ctrl+S` = 保存（与现有 `exportImage` 语义一致）。
   - 失败/部分成功时，HUD 换成黄色/红色状态 + 排查清单提示，按钮仍是「保存已捕获部分」。

### 6.2 截图窗新增 UI 元素

| 元素 | 位置 | 说明 |
|---|---|---|
| 工具栏按钮「滚动截图」 | 工具栏 OCR 之后 | 图标：一页纸 + 下方虚线续页（自绘 SVG，放 `ICONS`） |
| 开始面板 | 选区右下角 / 左上角自动避让 | 复用 `.popup` 玻璃拟态样式 |
| 捕获 HUD（进度胶囊 + 停止） | 选区外，自动避让（见 `positionHelpBox()` 逻辑） | 新增 `#scroll-hud` |
| 缩略预览 | HUD 右侧，宽 ~120px，高度自适应、超出屏幕则缩放显示 | 新增 `#scroll-preview`（`<canvas>`，前端把后端发来的条带按比例画上去） |
| 匹配状态灯 | HUD 内小圆点：绿=本帧匹配成功 / 黄=低置信 / 红=失败 | 对齐 PixPin 的「绿色表示匹配成功」 |

i18n 新增键（三种语言都要，`src/i18n.ts`）：`shot.scroll`、`shot.scrollStart`、`shot.scrollStop`、`shot.scrollFrames`、`shot.scrollDone`、`shot.scrollPartial`、`shot.scrollNotScrollable`、`shot.scrollFailed`、`shot.scrollOpenViewer`、`shot.scrollRetry`、`shot.scrollHint.*`（排查清单）以及 `settings.scroll.*`。

### 6.3 结果落地（分阶段）

| 阶段 | 出口 | 工作量 |
|---|---|---|
| **P1** | 长图直接由 Rust 落盘到桌面 / 写剪贴板（复用 `finish_screenshot` 的两条分支，但从 Rust 内存直接编码，不走前端 canvas），并 `emit("open-image", {path})` 让**主窗口查看器自动打开这张长图**（`main.ts` 已有 `openFileOrFolder()` + `showSingle(0)`，加一个 `listen` 即可） | 小 |
| **P2** | 覆盖窗内结果预览：整图按「适应高度」缩放居中显示，`滚轮`=上下平移、`Ctrl+滚轮`=缩放，HUD 显示尺寸/帧数/置信度 | 中 |
| **P3** | **长图标注**：给标注器引入视图变换 `view = {scale, offsetX, offsetY}`：<br>· `physPos(e)` = `(clientX - rootLeft) / scale + offsetX`（其余命中测试/绘制逻辑因坐标仍是图像物理像素而**不用改**）<br>· `render()` 里 `ctx.setTransform(scale,0,0,scale,-offsetX*scale,-offsetY*scale)`<br>· `exportImage()` 完全不用改（本来就在图像像素空间裁剪 + 合成）<br>· 顺带白送「裁剪」功能：拉选区 → Enter 即导出裁剪结果 | 中（~100-150 行前端重构，但动的是核心交互路径，需要回归测试） |

> **P3 的替代方案**（若不想动标注核心）：长图只在查看器里看，标注退化为「对屏幕局部截图标注」。不推荐——用户拿到 9000px 长图却没标注手段是体验断档，而 P3 的收益（裁剪 + 标注）远超成本。

---

## 7. 接口契约

### 7.1 Rust 命令（`src-tauri/src/scroll_capture.rs`，注册进 `lib.rs::invoke_handler`）

```rust
#[derive(Deserialize)]
pub struct ScrollCaptureRequest {
    pub x: i32, pub y: i32, pub w: u32, pub h: u32,   // 物理像素，虚拟桌面坐标
    pub method: Option<String>,      // "auto" | "wheel_post" | "wheel_input" | "vscroll" | "pagedown"
    pub scroll_amount: Option<u8>,   // 每次滚动格数，默认 1
    pub settle_timeout_ms: Option<u32>,
    pub auto_scroll_top: Option<bool>,
    pub max_height_px: Option<u32>,
    pub max_frames: Option<u32>,
    pub backend: Option<String>,     // "screen" | "window"（P4）
}

#[tauri::command] pub fn start_scroll_capture(app: AppHandle, req: ScrollCaptureRequest) -> Result<(), String>;
#[tauri::command] pub fn stop_scroll_capture(app: AppHandle);            // 置 cancel 标志
#[tauri::command] pub fn scroll_capture_status(app: AppHandle) -> Option<ScrollCaptureProgress>;
#[tauri::command] pub fn save_scroll_capture(app: AppHandle, action: String) -> Result<String, String>; // "save"→返回路径 / "clipboard"
#[tauri::command] pub fn discard_scroll_capture(app: AppHandle);         // 结果丢弃，回正常截图流程
```

### 7.2 事件

```rust
#[derive(Serialize, Clone)]
pub struct ScrollCaptureProgress {
    pub frames: u32,
    pub height: u32,          // 当前累积高度（px）
    pub width: u32,
    pub status: String,       // "probing" | "capturing" | "settling" | "matched" | "low_confidence" | "done" | "partial" | "failed"
    pub message: Option<String>,
    pub strip_png: Option<String>, // 仅新追加条带的缩放缩略（宽 ≤160px 的 PNG data URL），用于实时预览
}

#[tauri::command] /* 事件 */ // event: "scroll-capture-progress" -> ScrollCaptureProgress
// event: "scroll-capture-done" -> { ok: bool, width: u32, height: u32, frames: u32, confidence: String, saved_path: Option<String> }
// event: "open-image" -> { path: String }   // 主窗口查看器打开长图
```

> 性能红线：`strip_png` 只发**新追加的条带**且缩放到宽 ≤160px（单帧几 KB），**绝不**发整图；结果图只在 `done` 后由 `save_scroll_capture` 或按需 `get` 一次。

### 7.3 前端（`src/api.ts` 追加）

```ts
export interface ScrollCaptureRequest { x: number; y: number; w: number; h: number; scroll_amount?: number; auto_scroll_top?: boolean; /* ... */ }
export const startScrollCapture = (req: ScrollCaptureRequest) => invoke<void>("start_scroll_capture", { req });
export const stopScrollCapture = () => invoke<void>("stop_scroll_capture");
export const saveScrollCapture = (action: "save" | "clipboard") => invoke<string | null>("save_scroll_capture", { action });
export const discardScrollCapture = () => invoke<void>("discard_scroll_capture");
```

### 7.4 Rust 依赖/feature 变更（`src-tauri/Cargo.toml`）

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.62", features = [
  # 既有 ...
  "Win32_Graphics_Gdi",                    # BitBlt 区域捕获
  "Win32_UI_Input_KeyboardAndMouse",       # SendInput / SetCursorPos / MapVirtualKeyW
  "Win32_UI_HiDpi",                        # 独立探针二进制显式设置 per-monitor DPI aware
] }
```
（`image` 已有 `imageops`；缩略与灰度转换无需新依赖。无新增 crate。）

---

## 8. 配置项与设置面板

`config.rs` 新增（serde `default`，保证旧 config.json 兼容）：

```rust
#[derive(Serialize, Deserialize, PartialEq, Clone)]
pub struct ScrollCaptureConfig {
    #[serde(default = "d_true")]  pub auto_scroll_top: bool,      // 开始前先滚到顶部
    #[serde(default = "d_one")]   pub scroll_amount: u8,          // 每次滚动格数 1..=5
    #[serde(default = "d_200")]   pub settle_timeout_ms: u32,     // 稳定帧最长等待
    #[serde(default = "d_true")]  pub auto_ignore_bottom_edge: bool,
    #[serde(default = "d_auto")]  pub scroll_method: String,      // "auto" | "wheel_post" | "wheel_input" | "vscroll" | "pagedown"
    #[serde(default = "d_20000")] pub max_height_px: u32,
    #[serde(default = "d_true")]  pub show_preview: bool,
}
// Config 增加： #[serde(default)] pub scroll_capture: ScrollCaptureConfig,
```

设置面板（`index.html` `#settings` + `main.ts` + i18n）新增一节「滚动截图」：回顶开关、每次格数、稳定等待、最大高度、显示实时预览、滚动方式（自动/滚轮消息/模拟滚轮/滚动条/PageDown）+ 「恢复默认」。

---

## 9. 实施计划

| 阶段 | 内容 | 产出与验收 | 估时 |
|---|---|---|---|
| **P0 技术验证**（风险最高，先做） | 只写不依赖 UI 的原语：区域 BitBlt 捕获 + 目标窗口解析 + 4 种注入 + settle 等待 + 探针 binary | **✅ 已完成**：三种目标（WinForms ListBox / Chrome / 资源管理器）的兼容性矩阵与五条设计修正见附录 A | ✅ |
| **P1 可用 MVP** | `scroll_capture.rs` 会话 + 拼接（5.x 算法）+ 探针自动降级 + 前端入口/开始面板/HUD + 保存/复制/查看器打开 | **✅ 已完成**：① 命令行端到端（Chrome 长网页，60 段唯一内容 + 灰阶标尺校验全过，14 帧/25s）；② 应用内端到端（Alt+S → S → 拖框 → Enter，长图成功产出，用户实测确认）。过程中抓到 5 个真 bug，见**附录 C** | 已完成 |
| **P2 体验补齐** | **✅ 入口重构（已完成）**：专属热键 `Alt+Shift+S` 直达滚动截图 + 框选完自动开始 + 单击窗口直接开跑 + 设置面板里可改这个热键；余下：设置项（每次格数/延迟/最大高度/注入方式）、结果态裁剪、边界文案完善 | 慢渲染页面（懒加载列表）能正确等待；纯色/重复内容给出「低置信」而不是错误拼接 | 入口部分已完成；余 1 天 |
| **P3 长图标注** | 标注器视图变换（zoom/pan）+ 结果预览态 + 滚轮平移 + 导出裁剪 | 9000px 长图可缩放标注、可裁剪导出，原有常规截图标注回归通过 | 2-3 天 |
| **P4 增强（可选）** | 手动滚动模式（含向上滚动裁剪）、横向长截图、窗口捕获后端、MCP 工具 `capture_scrolling_window`、超大图分块保存 | 对标 PixPin 的功能面 | 2-3 天 |

**建议节奏**：P0 单独提交（验证结论写进本文件的「附录 A：兼容性矩阵」），P1 打 v0.2.0 tag，P2/P3 跟进。

### 9.1 入口设计（P2 已完成，对齐市面做法）

原流程是「Alt+S → 按 S 切模式 → 框选 → 点开始」四步，对高频使用偏重。市面两种流派：

| 产品 | 入口 | 选完区域后 |
|---|---|---|
| [ShareX](https://getsharex.com/docs/scrolling-screenshot) | 菜单/托盘，**或给 "Start/Stop scrolling capture" 单独绑全局热键** | **自动开始**；结束后右上角状态灯（绿=成功 / 黄=部分成功 / 红=前两张就对不上） |
| [PixPin](https://pixpin.cn/docs/configuration/actions) | 主路径 `Ctrl+1 → 框选 → 长截图`；但**「长截图」是独立动作，可单独绑全局热键** | 半自动（可手动滚） |
| Snipaste / QQ / 微信 | 截图 → 框选 → 工具栏「长截图」 | — |
| FastStone / PicPick | **独立 "Scrolling Window Capture" 模式** | 选完自动滚 |

结论：**专业截图工具都用独立入口 + 选完自动开始**，聊天系产品才走「截图里再选长截图」。因此改成：

1. **`Alt+Shift+S`（可自定义）直达滚动截图**：按下即进「待框选」态，省掉 Alt+S → S 两步；
2. **框选完自动开始**（ShareX 同款），留 260ms 缓冲——这期间按 Esc 可取消，方便微调选区；
3. **单击窗口 = 直接对该窗口开跑**（复用绿框吸附），最快路径变成「按热键 → 点一下浏览器」；
4. 旧的工具栏图标与 `S` 键**全部保留**，覆盖「已经按了 Alt+S 才想改长截图」的场景。

---

## 10. 测试计划

### 10.1 Rust 单元测试（纯函数，无需屏幕）

`find_vertical_overlap` 必须可单测，用合成图覆盖：

| 用例 | 期望 |
|---|---|
| 随机噪声图整体上移 d，无固定区域 | `shift == d`，高置信 |
| 上移 d + 顶部 24px 吸顶标题栏（两帧相同） | `shift == d`，追加区不含标题栏 |
| 上移 d + 底部 40px 吸底工具栏（两帧相同） | `bottom_fixed == 40`，吸底栏只在结果底部出现一次 |
| 左/右各 60px 滚动条像素不同 | 不影响匹配结果 |
| 两帧完全相同 | 返回「到底/无位移」 |
| 帧内容完全不同（跳变/新页） | 返回失败（不产生错误拼接） |
| 纯色区域（无法匹配） | 返回失败/歧义，不产生随机错位 |
| 位移 3× 跳变 | 置信度下调 |

### 10.2 手工矩阵（每阶段回归）

| 目标 | 关注点 |
|---|---|
| Chrome/Edge 长网页 | 主场景；滚动条在选区内、sticky 导航栏 |
| 资源管理器（大图标/详细列表） | 标准滚动条、虚拟列表 |
| 微信/QQ 聊天记录 | 吸底输入框、吸顶群名 |
| VS Code / 终端 | 自绘滚动、行高非整数 |
| 记事本 / 设置（UWP） | `WM_VSCROLL` 路径、UWP 输入模型 |
| Excel/表格类 | 冻结窗格（固定区域）→ 期望「低置信提示」而不是静默错位 |
| 多屏 / 混合 DPI | 选区跨屏、`scale != 1`、坐标换算 |
| 大图 | 8000px+ 长图的内存/编码时间/剪贴板可用性 |

### 10.3 自测页面与确定性目标（✅ 已就绪）

- `tools/scroll-probe/page.html`：长页面（吸顶导航 + 吸底工具栏 + 每屏唯一内容，`?plain=1` 去固定元素、`?anim=1` 加动态块、`?height=N` 改长度），用作**可复现**的端到端素材。
- `tools/scroll-probe/winforms-target.ps1`：WinForms ListBox（标准滚动条、几何已知），用来把「注入无效」与「应用不吃这种方式」区分开。
- 探针 `src-tauri/src/bin/scroll_probe.rs`：`--list / --ascii / --dump / --verbose / --steps / --methods`，可在无图形环境里肉眼确认捕获内容。
- 注意：`pick_window_at` 会跳过本应用自己的窗口，若要拿 CloverViewer 自身窗口当目标，需要一个 `#[cfg(debug_assertions)]` 的开关。

---

## 11. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| **滚轮注入对某些应用无效** | 高（**P0 已实测确认存在**：资源管理器不吃滚轮消息） | 四级自动降级（①→②→③④）+ 探针预检 + 明确失败文案 + P4 手动滚动模式兜底 |
| **Chrome/Chromium 平滑滚动动画导致截到中间帧** | 高（**P0 实测 ≈1.1s 才停**） | settle 稳定帧等待（默认超时 1500ms）；绝不使用固定延迟 |
| **周期性强内容（等距列表 / 图标网格）导致位移估计失效** | 中（**P0 实测已复现**） | 行指纹 + 双候选歧义判定 + 位移一致性投票；以子窗口滚动条位置作为最硬判据；失败时明确标「低置信」而不是静默错位 |
| **动态内容/动画导致匹配失败**（视频、gif、加载动画、无限滚动） | 高 | settle 稳定帧等待 + 容差匹配 + 低置信标记 + 中止时保留部分结果 + 提示清单 |
| **纯色 / 大面积重复排版导致误匹配** | 中 | 最小重叠长度 + 双候选歧义判定 + 位移一致性投票 |
| 目标窗口被第三方窗口遮挡（后端 A） | 中 | 开始时把目标窗口提到前台（覆盖窗始终置顶不影响）；提示「请先让目标窗口可见」；P4 加窗口捕获后端 |
| 覆盖窗透明区域其实带一点点半透明/阴影 → 捕获被污染 | 中 | P0 验证时直接比对「清空画布后的捕获帧」与「目标窗口真实内容」；必要时改为「捕获前瞬间隐藏覆盖窗」（ShareX 路线）作为后端 A2 |
| 单帧 PNG/base64 开销拖垮流程 | 高（已识别） | 全流程 RGBA 内存，只在最后编码一次；预览只发缩放条带 |
| 超长图内存/导出失败 | 中 | 默认 20000px 上限 + 内存上限保护 + 分块保存（P4）；文案提示「超长图部分软件打不开」 |
| 用户误操作打断（点击/滚动/切窗口） | 中 | 覆盖窗拦截鼠标 + 覆盖窗持有键盘焦点 + `Drop` 提示「捕获中请勿操作」 |
| 坐标系（虚拟桌面物理像素 vs 逻辑像素）再次踩坑 | 中 | 沿用现有约定（全部物理像素），并复用 `monitor_info` 诊断日志格式 |
| 与主窗口查看器联动时主窗口是隐藏的（托盘态） | 低 | `open-image` 事件前先 `show_main_window()` |

---

## 12. 待决策的开放问题

**已定（评审确认）**：

1. **P1 结果出口**：直接保存到桌面 + 主窗口查看器自动打开（`open-image` 事件 → `main.ts` 打开长图）。预览态与长图标注放到 P2/P3。
2. **默认驱动模式**：**自动滚动**（程序发滚轮），手动滚动模式作为 P4 的兜底。
3. **实施顺序**：先做 P0 技术验证 —— ✅ 已完成（附录 A）。

**仍待确认**：

4. **结果是否需要「上/下裁剪」UI**：如果走 P3 的视图变换，直接用「拉选区 → Enter 导出裁剪」代替专用裁剪按钮，够不够？
5. **MCP 工具**要不要一起做（`capture_scrolling_window`）？它能让「长截图」成为 MCP 客户端的独占能力，但会引入「无 UI 情况下抢焦点滚动前台窗口」的副作用，需要额外设计（例如要求显式传入 `window_title` 或 `region`）。
6. **是否接受为窗口捕获（WGC/PrintWindow）新增依赖/复杂度**（P4），换取「遮挡场景可用 + 覆盖窗可自由绘制」。

---

## 附录 A：P0 技术验证结论（✅ 已完成）

> 验证环境：Windows 11 · 3840×2160 @125% · Rust 1.97.1 · xcap 0.9.8
> 工具：探针（`src-tauri/examples/scroll_probe.rs`，`cargo run --example scroll_probe`）+ `tools/scroll-probe/`（测试页与确定性目标）
> 复现方式见 A.4；结论已回灌到第 4.3 / 4.5 / 5.4 / 9 节。

### A.1 结论矩阵

| 目标（可滚动内容） | `wheel_post`<br>（发最深层子窗） | `wheel_post_root`<br>（发顶层） | `SendInput`<br>真滚轮 | `WM_VSCROLL`<br>（发子窗） | `PageDown`<br>（发子窗） | 稳定耗时 |
|---|---|---|---|---|---|---|
| **WinForms ListBox**（标准滚动条 2000 行，几何已知） | ✅ 精确 +3 行/格 | ❌ 完全不动 | ✅ 精确 +3 行/格 | ✅ +1 行/次 | ✅ 一页 | 150–620ms |
| **Chrome**（长网页，本地测试页） | ✅ ≈125px/格 | ✅ | ✅ ≈125px/格 | ✅ | ✅ | **≈1100ms** |
| **资源管理器**（文件列表 `DirectUIHWND`） | ❌ | ❌ | ✅ ≈4.4% 像素/格 | ❌ | ✅ | 170–420ms |

- 判定证据：ListBox 用**子窗口滚动条位置**（`GetScrollInfo` 的 `pos` 精确递增）；Chrome / 资源管理器没有标准滚动条，用**帧像素变化 + 多步一致性**。
- 区域 BitBlt 捕获在三种目标上均验证可用（探针 `--ascii` 把捕获帧渲染成亮度图肉眼确认，没有依赖任何截图工具）。

### A.2 五条会改设计的发现

1. **`WM_VSCROLL` / `PageDown` 必须发给最深子窗口**，发给顶层窗口时 ListBox 完全不动 —— 这是 P0 直接抓到的实现 bug（初版就是发顶层），已在 `scroll_capture.rs` 修正。同理 `GetScrollInfo` 也必须查子窗口，否则会把明显可滚动的窗口误判成「无滚动条」（初版把资源管理器和 ListBox 都误判了）。
2. **没有任何单一注入方式能覆盖所有应用**：`wheel_post` 不需要焦点、不需要覆盖窗让路，在 Chrome 与标准控件上都能滚，**但资源管理器不吃**；资源管理器只认 `SendInput` 真滚轮或 `PageDown`。→ 必须做**探针 + 按目标自动降级**，建议顺序 `wheel_post → SendInput → PageDown → WM_VSCROLL`。
   → **对覆盖窗策略的直接影响**：走 `SendInput` 时覆盖窗必须**临时 click-through**（`set_ignore_cursor_events(true)`）且光标落在选区中心，否则滚轮事件会被自己的覆盖窗吃掉（已同步到 4.5）。
3. **Chrome 的平滑滚动动画约 1.1s 才停**（ListBox 只要 0.15–0.6s）。固定的 `ScrollDelay = 200ms` 会**稳定地**截到「滚到一半」的中间帧，画面永远拼不对 → **settle 稳定帧等待不是优化项，是必需品**（5.4 的前提）；捕获节拍应按「稳定」而不是「固定延迟」来定。
4. **周期性内容会让朴素位移估计彻底失效**：等距同款列表（ListBox 2000 行、资源管理器图标网格）滚动 3 行后，全图 SAD 在几乎所有位移上都一样小，估计器报 `shift=0`、且 `err@0 == err`。→ 5.2 的「歧义检测 + 位移一致性投票」是硬需求；同时**绝不能把「像素 diff 很小」当成「没滚动」的判据**（这种场景 diff 只有 3–8‰，而真滚动就是发生了）。
5. **光标停在选区内会污染帧**：悬停高亮带来 ≈0.1% 的像素差，而且它出现在每帧的**同一位置**，会被拼接当成「固定元素」处理。→ `SendInput` 路径采用「光标进选区发滚轮 → 立刻把光标移出选区 → 再截帧」的节拍（已同步到 4.5）。

### A.3 环境限制（影响以后复跑）

- 在本工具的沙箱 shell 里直接启动 Chrome 会因**命名管道被拒**而无法渲染页面（Chrome 自身 IPC 走命名管道：`FATAL: platform_channel.cc: Access denied (0x5)`）。表现为「浏览器窗口在、标题是『无标题』、页面空白、所有注入方式都显示『滚不动』」的**假阴性**——第一轮就被这个骗了一次（当时误以为五种注入全部失败）。跑浏览器用例需用非沙箱方式启动浏览器，或直接使用用户已打开的浏览器窗口。
- 沙箱会在**每条命令结束时回收其子进程**，所以「启动目标窗口」和「跑探针」必须在同一条命令里执行（`explorer.exe` 除外——它是把请求交给已在运行的 shell 进程）。

### A.4 复现方式

```powershell
# 1) 确定性目标：WinForms ListBox（标准滚动条、几何完全已知，用来验证注入与判据）
pwsh -File tools/scroll-probe/winforms-target.ps1 -Items 2000

# 2) 探针（与上一步在同一条命令内、并行存活；--ascii 用于无图形环境肉眼确认捕获内容）
cd src-tauri
cargo run --example scroll_probe -- --title cloverprobe-winforms-target --no-maximize --steps 2 --ascii 78 --verbose

# 3) 浏览器用例：先用浏览器打开 tools/scroll-probe/page.html（含吸顶导航 + 吸底工具栏
#    + 每屏唯一内容，专为拼接算法设计），再对标题含 cloverprobe-scroll-test 的窗口探针
cargo run --example scroll_probe -- --title cloverprobe-scroll-test --steps 2 --verbose

# 4) 单测（纯函数，不需要屏幕）
cargo test --lib scroll_capture
```

## 附录 C：P1 端到端验证抓到的 5 个真 bug

这些 bug **命令行探针一个都抓不到**（探针没有截图覆盖窗、也不跑前端），全靠把应用真正跑起来、
用真实输入驱动（Alt+S → S → 拖框 → Enter → 剪贴板取图）才暴露。记录在此，避免以后重蹈：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 选区里根本没有目标窗口，滚轮发给谁都不知道 | 截图覆盖窗是 always_on_top 且铺满全屏，`WindowFromPoint` 直接返回**我们自己的覆盖窗** → 注入的消息发给自己，目标一动不动 | `deepest_child_at` 改为**按 Z 序枚举顶层窗口、跳过本进程**再取最深层子窗口（`window_below_own_at`），与 `pick_window_at` 同一套逻辑 |
| 2 | 所有注入方式都报「没有发生滚动」 | `screenshot.html` 给 `#screenshot-root` 铺了一层不透明深色底。前端清空画布**并不会让选区变透明** → 屏幕像素捕获永远截到我们自己的深色底，目标画面一帧都不变 | 滚动模式下把 root 背景设成 `transparent`（`syncScrollUi`），退出时恢复 |
| 3 | 拼接总是从第一帧就失败 | Chrome 平滑滚动是缓出曲线，**收尾阶段每 80ms 只挪一两个像素**；早期「连续 2 次采样差异 < 0.1% 即认定稳定」会在动画未停时截帧（标定值被算成 193px/格，真值约 125px/格） | 连续 **3** 次稳定采样才算稳定（`STABLE_POLLS`） |
| 4 | 长图里混进了左下角的 UI（用户实测报回） | 选区几乎占满屏幕时（最大化窗口就是），HUD 找不到「选区之外」的空位，退化成摆在选区内部 → 被截进长图 | 捕获期间若整屏都没有空位，**直接不显示 HUD**（`positionScrollUi`）；反馈改由选区边框颜色承担（绿/琥珀/红） |
| 5 | 手动框选「没反应」 | 选区中心落在不可滚动的地方（工具栏/留白/别的窗口）时，探针报错只写在小面板的一行小字里，不显眼 | 面板在 armed 态**始终显示**（未选区域时「开始」置灰），错误文案加粗标红 |

另外两个**非 bug 但重要**的工程结论：

- **`src/bin/*.rs` 会干扰 `tauri build` 的主程序识别**（`Built application at: ...scroll_probe.exe`）——探针已挪到 `src-tauri/examples/scroll_probe.rs`（`cargo run --example scroll_probe`），不再参与应用构建。
- **调试期一定要用嵌入资源的二进制**：`cargo build` 出来的 debug 包走 `devUrl`，没有 vite dev server 时前端根本不加载（覆盖窗会一直隐藏，表现为「Alt+S 之后什么都没发生」）。用 `npm run tauri build -- --debug --no-bundle`。

## 附录 E：发布 v0.1.2 前的代码 review 结论（✅ 已修）

发布前对滚动截图这条线做了一次通读 review，抓到 5 处**只会在特定路径上出现**的问题。
它们都不影响「正常跑一遍长截图」的主路径，但都属于「一旦触发就看起来像功能坏了」的类型：

| # | 现象（用户视角） | 根因 | 修复 |
|---|---|---|---|
| 1 | 用 Esc 停掉 / 会话中途出错之后，**整个覆盖窗像死了一样**：点不到任何按钮，全局 Esc 也失效 | `run_session_ext` 的收尾（还原 click-through、注销临时全局 Esc、清任务栏进度）写在函数末尾，而函数里有大量 `?` 与显式 `return Err`（每次 `settle_capture`/`append_band`/`encode_png`）——任何一条错误路径都会**跳过**收尾，把覆盖窗留在 click-through | 引入 `SessionCleanup` 租约（`Drop` 兜底），在任何可能提前返回的操作**之前**声明 |
| 2 | 在页面**底部**按下滚动截图，报「该区域没有发生滚动，可能不可滚动」 | 「位移 < `MIN_SHIFT`」与「注入方式完全无效」被混为一谈：候选表耗尽后统一走「不可滚动」错误。而 `shift ∈ (0, MIN_SHIFT)` 恰恰是「已经到底」的观测证据 | 新增 `bottom_reached` 标记：观测到小位移且候选试完时，按「已到底」收尾（保留首帧内容），不再误报不可滚动 |
| 3 | 结果态 HUD 的按钮与缩略预览**全都不显示**（或后续某次滚动截图 HUD 不见了） | 采帧让位用的是 `visibility:hidden` 的 `.hud-hidden` 类，而它只在后端 emit `hidden=false` 时才被移除。会话异常结束时没人清 → 类一直挂着 | 前端 `syncScrollUi()` 在**离开捕获态**时无条件移除 `.hud-hidden`（前端自愈，不依赖后端事件到达） |
| 4 | 实时缩略预览与最终长图**对不上**（预览多出一个页脚高度） | 容差兜底路径里，`append_band` 按「正文结束于 `h - footer`」追加，而预览裁剪却按 `h - shift` 取条带 —— 两者差了 `footer_h` | 预览裁剪与 `append_band` 用同一套下标换算（`h - footer - shift` 起） |
| 5 | 标定完「每步滚动像素」后，反而可能每步只追加一点点、帧数暴涨 | `match_frames` 的先验只在 `[prior/4, prior×4]` 内找候选；标定把每步从 1 格放大到 N 格后，先验仍是**旧尺度**，正确候选被整批筛掉 | 标定 `notches` 后清空 `last_shift`，让下一帧重新自由匹配一次 |

顺带清理：删掉了 `probe_scroll_method`、`did_scroll`、`SCROLLED_DIFF_RATIO` 这三处**已无人调用**的遗留实现
（探测逻辑早已内联进主循环的「挨个试」），以及一处与 `STABLE_POLLS` 矛盾（写「两次」实际三次）的注释。

> 教训（值得写下来）：这次 5 个问题里有 3 个的共同形态是「**收尾/状态还原只在成功路径上做了**」。
> 会话型功能（有租约、有临时全局状态、有宿主窗口开关）应当一律用 `Drop` 兜底，而不是在末尾手写清理。

## 附录 D：改动文件清单（实际）

| 文件 | 改动 | 状态 |
|---|---|---|
| `src-tauri/src/scroll_capture.rs` | **新增**：区域捕获、目标/子窗口解析（跳过自身窗口）、四种滚动注入、稳定帧等待、分段指纹拼接、主循环试错降级、`SessionCleanup` 宿主租约、会话状态机与 8 个命令、13 个单测 | ✅ P0+P1 |
| `src-tauri/examples/scroll_probe.rs` | **新增**：兼容性探针 + 完整会话 CLI + 灰阶标尺校验器（`--list/--ascii/--dump/--session/--verify-ruler`） | ✅ P0+P1 |
| `tools/scroll-probe/page.html` | **新增**：拼接验证页（吸顶/吸底/每屏唯一内容/灰阶标尺/可选动图） | ✅ P0+P1 |
| `tools/scroll-probe/winforms-target.ps1` | **新增**：确定性可滚动目标（ListBox） | ✅ P0 |
| `tools/stitch-overlap-trace.cjs` | **新增**：离线复刻 `append_band`/`attach_footer` 算式，校验「每步净增 = shift」 | ✅ P1 |
| `tools/scroll-ui-geometry-check.cjs` | **新增**：离线复刻面板/HUD 落位逻辑，喂真实多屏参数检查是否压住捕获区 | ✅ P1 |
| `src-tauri/Cargo.toml` | 追加 `Win32_Graphics_Gdi` / `Win32_UI_Input_KeyboardAndMouse` / `Win32_UI_HiDpi` | ✅ P0 |
| `src-tauri/src/lib.rs` | 注册 `pub mod scroll_capture` + `ScrollCaptureSession` + 8 个命令 + `StartupNotices` + 滚动静默热键 | ✅ P1+P2 |
| `src-tauri/src/screenshot.rs` | 抽出 `try_begin_capture`/`end_capture` 共用互斥 + `take_scroll_start_mode`（专属热键启动意图） | ✅ P1+P2 |
| `src-tauri/src/config.rs` | `HotkeysConfig.scroll_capture`（默认 `Alt+Shift+S`，`serde(default)` 向后兼容） | ✅ P2 |
| `src/api.ts` | 滚动截图命令与类型 + `takeStartupNotices` | ✅ P1+P2 |
| `screenshot.html` | 开始面板 / 进度 HUD / 结果 HUD 的样式 | ✅ P1 |
| `src/screenshot.ts` | 工具栏按钮、`S` 快捷键、框选完自动开始、开始面板、HUD、事件监听、滚动模式渲染（选区透明 + 外框 + 避开 HUD） | ✅ P1+P2 |
| `src/main.ts` | `open-image` 事件 → 查看器打开长图；启动阶段热键冲突提示 | ✅ P1+P2 |
| `src/i18n.ts` | `shot.scroll*` / `shot.hint.scroll` / `notice.hotkey*` / `toast.opened` 三语言 | ✅ P1+P2 |
| `index.html` | 设置面板新增「滚动截图热键」 | ✅ P2 |
| `README.md` / `README.en.md` / `README.ja.md` | 功能列表与快捷键表补「滚动截图」 | ✅ v0.1.2 |
| `CHANGELOG.md` / `.github/workflows/release.yml` | 版本变更说明（Release 正文由 workflow 生成） | ✅ v0.1.2 |
| 设置项（每次格数 / 延迟 / 最大高度 / 注入方式） | 尚未做成 UI 设置项（当前由后端按目标自动标定） | 🚧 P3 |
| `src/screenshot.ts` | 结果态裁剪 / 长图标注（视图变换 zoom+pan） | 🚧 P3 |
