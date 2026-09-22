# 项目架构与目录说明

## 概览

CloverViewer 是一个基于 Tauri 2 的 Windows 桌面图像查看器和截图工具。它由 WebView 内运行的 TypeScript 前端、提供原生能力的 Rust 后端，以及可独立运行的 MCP 服务组成。

```text
index.html / screenshot.html
        │
        ▼
TypeScript 页面入口与领域控制器
        │  api.ts（Tauri invoke / event 边界）
        ▼
Rust Tauri 命令与应用状态
        │
        ▼
文件系统、图像处理、窗口、热键、OCR、屏幕捕获
```

常规 GUI 以 Rust 创建窗口并加载页面。前端不直接调用操作系统 API；跨边界操作统一经 `src/api.ts` 调用 Tauri 命令或订阅事件。MCP 模式直接在 Rust 侧启动，不依赖 GUI 窗口和前端初始化。

## 运行入口

| 入口 | 职责 |
| --- | --- |
| `src-tauri/src/main.rs` | 进程入口。默认启动 GUI；`--mcp` 启动 stdio MCP 服务；`--mcp-http` 启动仅本机监听、需 Bearer Token 的 HTTP MCP 服务。 |
| `src-tauri/src/lib.rs` | 组装 Tauri 应用：管理状态、注册命令、插件、全局热键、托盘、单实例和窗口生命周期。 |
| `index.html` / `src/main.ts` | 主查看器窗口的页面骨架和前端入口。 |
| `screenshot.html` / `src/screenshot.ts` | 截图窗口的页面骨架和组合入口。 |

## 前端目录

| 路径 | 职责 |
| --- | --- |
| `src/api.ts` | 前端与 Rust 的唯一业务桥接层；定义共享数据类型，并封装 `invoke` 和 Tauri 事件。 |
| `src/main.ts` | 主窗口组合入口：连接查看器控制器、设置/关于/菜单/窗口外观控制器，并编排加载流程。 |
| `src/viewer/` | 查看器领域。`viewer-session.ts` 保存目录、图片与视图状态；`grid-controller.ts` 管理缩略图网格；`single-image-controller.ts` 管理单图变换和手势；`image-properties-controller.ts` 显示属性；`image-share-controller.ts` 管理当前图片的局域网分享面板。 |
| `src/screenshot.ts` | 截图页面组合入口，保留页面级 DOM、窗口事件和跨模块调度。 |
| `src/screenshot/` | 截图领域实现：会话与历史、输入与快捷键、标注绘制、选区几何、工具栏/面板、文本输入、放大镜、导出、OCR、滚动截图、局域网分享及窗口生命周期。 |
| `src/ui/` | 与页面外观或通用交互相关的控制器，如设置（分类 + 搜索 + 缓存维护）、关于、右键菜单、窗口标题栏和应用桥接。 |
| `src/locales/` | 各语言的静态翻译表。新增文案须同步更新所有语言表。 |
| `src/i18n.ts` | 语言选择、插值、页面翻译应用；不承载具体翻译数据。 |
| `src/styles.css` | 全局设计 token 与页面/组件样式。 |
| `src/version.ts` | 由构建流程使用的版本信息。 |

### 主窗口数据流

`main.ts` 读取配置和启动参数后创建查看器会话。目录扫描、缩略图、图片属性、配置写入等需要原生能力的操作通过 `api.ts` 进入 Rust 命令；控制器把结果映射为网格、单图视图或属性面板。设置、菜单和窗口控制器只负责自己的 UI 边界，不保存查看器的核心状态。

### 截图数据流

后端热键或命令创建截图窗口，并向前端发送截图刷新事件。`screenshot.ts` 将事件交给生命周期和加载模块，之后由编辑会话保存画布、选区和历史；输入、快捷键、工具栏与面板控制交互，渲染器负责画布重绘。普通截图通过导出/OCR 路径返回后端，滚动截图则由独立的会话、控制器、布局和 HUD 模块协调。

截图坐标、图像像素与窗口缩放是高风险边界。涉及选区、拼接或导出的修改应优先复用 `src/screenshot/` 中已有的几何、布局和图像辅助模块，避免在页面入口重复换算。

## Rust 后端目录

| 路径 | 职责 |
| --- | --- |
| `src-tauri/src/commands.rs` | Tauri 命令边界：配置、文件打开、图片查询、热键、窗口操作与临时缓存维护（`get_cache_summary` / `clear_temp_cache`）。 |
| `src-tauri/src/config.rs` | 应用配置的数据模型、读取与持久化。 |
| `src-tauri/src/image_scan.rs` | 文件夹中的图像扫描与排序。 |
| `src-tauri/src/image_info.rs` | 图像和 EXIF 信息读取。 |
| `src-tauri/src/thumbnails.rs` | 缩略图生成、缓存与读取。 |
| `src-tauri/src/screenshot.rs` | 常规屏幕捕获、截图窗口和导出相关的原生实现。 |
| `src-tauri/src/lan_share.rs` | 临时、令牌保护的局域网图片分享服务与二维码生成。 |
| `src-tauri/src/ocr.rs` | Windows OCR 调用与结果转换。 |
| `src-tauri/src/scroll_capture/` | 滚动截图领域：平台交互、帧匹配、位移计算、拼接、预览、会话和 Tauri 桥接。 |
| `src-tauri/src/mcp/` | MCP 截图服务：传输、工具协议、截图产物存储和捕获逻辑。 |
| `src-tauri/src/startup.rs` | 开机启动设置。 |
| `src-tauri/capabilities/` | Tauri 能力声明，限定 WebView 可调用的插件能力。 |

`lib.rs` 是后端的装配点，不应承载图像算法、配置细节或协议处理。新的原生能力应先放入对应领域模块，再由 `commands.rs` 或专用桥接模块公开给前端。

## 配置、类型与跨端契约

配置由 Rust 持久化，前端经 `api.ts` 读取和更新。跨端 DTO 的字段名、可选性与枚举值属于稳定契约：修改 Rust 命令、事件载荷或配置结构时，应同时检查 `src/api.ts`、调用控制器和相关单元测试。

前端接口遵循 Tauri 命令参数的实际命名约定。不要在 UI 控制器中散落 `invoke` 字符串或重复定义后端类型；先在 `api.ts` 增加封装，再向领域模块暴露语义化方法。

## 设置与临时缓存

设置页是主窗口内的整页视图：左侧分类（应用 / 截图 / 局域网分享 / 维护）与右侧设置行由 `settings-controller.ts` 的单一 `render()` 统一渲染，搜索词同时过滤分类与设置行；每项改动立即写入配置，热键类改动需要显式「应用」。新增设置项时须同时补齐 `index.html` 的设置行、三条语言表的键与说明文案，以及 `AppConfig` 的 Rust/TypeScript 两端字段。

临时缓存只涉及应用自己的目录 `%TEMP%\CloverViewer`，用于保存长截图「在查看器中打开」产生的 PNG。`get_cache_summary` 统计该目录的文件数与体积，`clear_temp_cache(older_than_hours)` 按最后修改时间删除（`0` 表示全部），并在应用启动时按配置的 `cache_cleanup_after_hours` 自动执行一次。维护逻辑只遍历该目录的普通文件：不跟随符号链接、不触碰系统 Temp 的其他内容，被占用而删除失败的文件只记录警告。

局域网分享由 `lan_share.rs` 持有单个临时 HTTP 服务状态；前端只经 `api.ts` 调用 `startLanShare`、`startImageLanShare` 和 `stopLanShare`。服务向同一局域网暴露带随机令牌的预览与下载地址，内容只保存在内存；到期、达到一次下载限制或主动停止后即失效。`AppConfig` 保存默认有效期和下载限制，截图与查看器各自的分享控制器只负责其界面状态。

## 国际化

翻译键的类型由 `src/locales/zh-CN.ts` 导出，英语和日语翻译表通过 TypeScript 约束与其保持键集合一致。添加文案的顺序是：

1. 在中文词典添加键和值。
2. 在英文、日文词典补齐对应翻译。
3. 在界面中通过 `t()` 或 `data-i18n` 使用该键。

这使遗漏翻译在类型检查阶段即可发现，而不是在运行时回退为空文本。

## 构建与测试

| 命令 | 用途 |
| --- | --- |
| `npm run tauri dev` | 同时运行 Vite 前端与 Tauri 桌面应用。 |
| `npm run tauri build` | 同步版本并构建发布产物。 |
| `npm run typecheck` | TypeScript 类型检查。 |
| `npm run lint` / `npm run format:check` | Biome 静态检查与格式检查。 |
| `npm run test:unit` | 编译指定 TypeScript 单元测试并运行测试执行器。 |
| `npm run check` | 执行格式、lint、类型、单元测试和版本一致性检查。 |
| `npm run release:check` | 发版前预检：CHANGELOG 版本段落、三语 README 同步、介绍页与 sitemap 一致性、签名私钥忽略状态。仅发版时运行，不要接进 CI。完整流程见 [发布流程](release.md)。 |

> 行尾：仓库按 LF 存储，`.gitattributes` 对 `*.ts`、`*.mjs`、`*.json` 显式声明 `eol=lf`。
> 否则在 `core.autocrlf=true` 的 Windows 环境里这些文件会被检出成 CRLF，Biome 会判定
> `format:check` 失败（CI 使用 LF 检出，因此只在本地出现）。

## 维护边界

- 页面入口负责组合，不应重新吸收已抽出的状态、渲染或输入逻辑。
- 一个控制器应拥有一个清晰的状态和 DOM 边界；跨领域协调放在入口或专用编排模块。
- 修改截图交互时，优先补充或调整对应的领域模块，而不是直接向 `screenshot.ts` 堆叠事件处理。
- 修改用户可见文字时，同步维护所有语言表，并运行类型检查。
- 增加 Tauri 命令时，明确它属于 GUI 命令还是 MCP 服务能力；两者可复用底层领域模块，但不要让 MCP 依赖窗口状态。
- 文件行数仅是预警信号。详见 [业务源码文件行数规范](code-size-guidelines.md)。
