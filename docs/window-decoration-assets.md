# 窗口装饰素材

2026-10-17 使用内置 imagegen 工具，从本次外观提案的 A/B 预览图生成独立透明 PNG；不是 Live2D 模型，不依赖桌宠素材。

| 素材 | 用途 |
| --- | --- |
| `public/window-decorations/lean.png` | A：右下角倚靠，全身坐姿 |
| `public/window-decorations/peek.png` | B：右上角探头，头肩与双手 |

两张图片请求 `transparent_background: true`，保留原始 alpha；直接复制工具生成结果，无后处理。它们由 Vite public 目录原样打包，设置预览与主窗口角色图层共用同一资源。角色资源只用于界面装饰，不参与图片导出。

## 分层与接触点

角色与 UI 面板在同一个透明窗口内绘制，不再创建附属角色窗口。B 以素材内部 y=91.5%（约 812/887）作为窗沿，对齐掌根并遮住 PNG 的原始下沿；前景 clip-path 只保留弯下来的四根手指，袖口与拇指留在后景，避免平切底边露在面板前。主窗口与设置缩略图共用 `--peek-hand-clip` 遮罩。A 以 x=60%、y=61.5% 作为坐靠位置，前景保留坐姿与双腿，后景长飘带可被面板遮挡。两个姿势均有独立的接触阴影。原图重复引用为前后两层，由代码原生遮罩决定显隐，不生成另一份失配的角色图片。遮罩与定位位于 `src/styles/window-shell.css`，设置缩略图同步使用相同层次。替换素材时需要重新校准接触位置与前景遮罩。测试覆盖 60%–140% 大小、系统 DPI 和界面缩放，浏览器用真实素材验证 60%/100%/140% 的像素布局，桌面 WebView 验证样式切换、最大化、菜单和截图回执。

生成提示词（原文）：

## A

```text
Use case: background-extraction / compositing. The input image is reference for ONLY the mint-haired clover anime girl at bottom right. Produce a production-ready single character cutout on ACTUAL transparent background, no UI, no window, no photograph, no desktop, no caption. Preserve the character's identity, drawing style, ivory/forest green outfit, hair ornament, cheerful face, seated leaning pose with chin resting on hand and crossed legs with sneakers. Show complete hair, ribbons, fingers, shoes with no crop. Imagine she sits on an invisible window corner: hips at approximately 60% image height; feet below. Place the entire character comfortably inside a portrait canvas with tight but safe 3% transparent margins. Original illustration aesthetic. Crisp clean alpha around all edges, no surrounding white/gray halo, no cast shadow onto background, no opaque background. This cutout will be displayed about 210px tall.
```

## B

```text
Use case: background-extraction / compositing. The input image is reference for ONLY the mint-haired clover anime girl peeking above the window at upper right. Produce production-ready standalone character cutout on ACTUAL transparent background, no UI, no window, no photograph, no desktop, no title/text. Preserve the character identity and soft illustrated style, mint bob, clover hair ornament, ivory/green outfit. Show only head/shoulders and both hands: one hand rests gripping an invisible horizontal window top edge at bottom of cutout, other hand waves beside face. Crop torso neatly at the imaginary horizontal edge; no rectangular background. All hair, waving fingers, leaf flourish must be inside canvas, not cropped. Wide landscape composition about 2:1, tightly framed with safe 3% transparent margins. Crisp alpha, no white/gray halo, no cast shadow onto background. This cutout will be displayed about 200px wide.
```
