# tools/ —— 开发期验证脚本

这里放的是**不参与应用构建**的验证素材与工具：Node.js 离线检查、浏览器验证页，以及需要
真实 Windows 桌面的 WinForms 目标。Rust 滚动探针位于 `src-tauri/examples/`，需要 Rust 工具链
和可交互桌面。当前拼接与浮层布局的自动回归检查分别由 Rust 单元测试和 `tests/unit/` 负责。

## scroll-probe/ —— 滚动截图的可复现素材与探针

| 文件 | 用途 |
|---|---|
| `scroll-probe/page.html` | 拼接验证页：吸顶导航 + 吸底工具栏 + 每屏唯一内容 + 灰阶标尺。`?plain=1` 去掉固定元素、`?anim=1` 加动态块、`?height=N` 改长度 |
| `scroll-probe/winforms-target.ps1` | 确定性可滚动目标（WinForms ListBox，标准滚动条、几何已知），用来把「注入无效」和「这个应用不吃这种方式」区分开 |

探针本体在 `src-tauri/examples/scroll_probe.rs`（`cargo run --example scroll_probe`），
放在 `examples/` 而不是 `src/bin/` 是有意的：`src/bin/*.rs` 会让 `tauri build` 误判主程序。
可先启动 `winforms-target.ps1`，再用 `scroll_probe` 对标题
`cloverprobe-winforms-target` 进行探测，以复现标准控件的滚动注入验证。

## 当前实现的自动检查

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib   # 滚动拼接与配准
npm run test:unit                                    # 前端布局、输入、渲染等单元测试
```

*   `src-tauri/src/scroll_capture/tests.rs` 使用合成帧验证位移、固定首尾栏、固定侧栏旁正文的配准、白色正文不误判、重复帧拒绝和未匹配后继续拼接。
*   `tests/unit/screenshot-overlay-layout.test.cjs` 直接导入编译后的 `src/screenshot/overlay-layout.ts`，验证普通选区工具栏和滚动截图面板的定位。调用入口分别为 `editor-ui-controller.ts` 与 `scroll-capture-layout.ts`，逻辑已不在 `src/screenshot.ts` 内。

## 历史几何演示

```powershell
node tools/scroll-ui-geometry-check.cjs
```

该脚本保留早期 `clampAvoiding` 定位算法，以主屏 2560×1440、竖屏副屏 1440×2560、虚拟桌面
4000×2560 的参数打印落点，供理解旧问题使用。它没有导入当前前端，算法也不同于现有
`placeScrollOverlay`；输出不能证明当前布局正确。维护现有定位时，以直接覆盖产品模块的
单元测试和真实桌面检查为准。

## Live2D 模型包校验

```powershell
node tools/verify-live2d-pet-model.mjs public/pet-model/clover-girl-2 clovergirl-2_v1.model3.json
```

检查当前 `clovergirl-2_v1` 模型定义引用的模型、纹理、物理和动作文件是否已完整导出。
