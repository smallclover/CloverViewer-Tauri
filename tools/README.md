# tools/ —— 开发期验证脚本

这里放的是**不参与应用构建**的验证工具。它们都只依赖 Node.js / PowerShell，不需要 WebView
或 Tauri 运行时，因此可以在命令行里确定性复跑，用来把「拼接算式」和「浮层落位」这两类
**纯逻辑**问题挡住——这两块恰恰是最容易改一处崩一处的地方。

## scroll-probe/ —— 滚动截图的可复现素材与探针

| 文件 | 用途 |
|---|---|
| `scroll-probe/page.html` | 拼接验证页：吸顶导航 + 吸底工具栏 + 每屏唯一内容 + 灰阶标尺。`?plain=1` 去掉固定元素、`?anim=1` 加动态块、`?height=N` 改长度 |
| `scroll-probe/winforms-target.ps1` | 确定性可滚动目标（WinForms ListBox，标准滚动条、几何已知），用来把「注入无效」和「这个应用不吃这种方式」区分开 |

探针本体在 `src-tauri/examples/scroll_probe.rs`（`cargo run --example scroll_probe`），
放在 `examples/` 而不是 `src/bin/` 是有意的：`src/bin/*.rs` 会让 `tauri build` 误判主程序。
复现步骤与实测结论见 [`SCROLL_CAPTURE_PLAN.md`](../SCROLL_CAPTURE_PLAN.md) 附录 A。

## 离线复刻：不接屏幕也能跑的两个校验

```powershell
node tools/stitch-overlap-trace.cjs        # 拼接算式：每步净增 = shift、页头页脚各一次
node tools/scroll-ui-geometry-check.cjs    # 浮层落位：面板/HUD 会不会压住捕获区、会不会漂到另一块屏
```

*   `stitch-overlap-trace.cjs` 用「每行唯一编号」的合成页面复刻
    `src-tauri/src/scroll_capture.rs` 的 `append_band` / `attach_footer` 算式。
    **改拼接算式时先改这里**，能立刻看到是否破坏了核心不变量。
*   `scroll-ui-geometry-check.cjs` 复刻 `src/screenshot.ts` 的浮层落位逻辑，
    喂的是真实的多屏参数（主屏 2560×1440 + 竖屏副屏 1440×2560，虚拟桌面 4000×2560）。
    ⚠ 它是**独立实现**（不是 import 前端代码），所以前端落位逻辑改了以后要同步改它，
    否则这份检查会退化成自说自话。

> 两个脚本都是「打印 + 目视判断」的形式，刻意没有做成断言式测试：它们要回答的是
> 「在真实多屏几何下会落到哪」，而具体数值随环境变化。
