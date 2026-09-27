# Clover Girl Live2D 资产说明

桌宠运行时使用 Live2D 模型包。当前接入 `clovergirl-2_v1`，通过官方 Cubism Web Framework 渲染、播放 PSD2Live 动作并计算物理。

## 资产位置

| 位置 | 用途 |
| --- | --- |
| `src/assets/desktop-pet/source/clovergirl-2_v1/` | 当前可继续编辑的 PSD 与 Cubism 工程文件 |
| `src/assets/desktop-pet/export/clovergirl-2_v1/` | 当前 PSD2Live 导出包，包含模型定义、动作、moc3、显示信息、物理文件与 4096 贴图 |
| `public/pet-model/clover-girl-2/` | 应用随包发布的 `clovergirl-2_v1` 运行时资产 |
| `public/live2d/` | Cubism Core 与官方 Web Framework 所需着色器 |

应用从 `public/pet-model/clover-girl-2/clovergirl-2_v1.model3.json` 加载模型。模型 JSON 内的路径必须保持相对路径；更换导出包时，请整体替换该目录中的模型、纹理及相关引用文件。

## 发布许可

Live2D Core、Web Framework 和着色器并不受本仓库 MIT License 覆盖；发布前按
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) 确认 Live2D SDK 的发布许可要求。
发布者已确认 Clover Girl 模型与美术由其在 AI 辅助下创作，并授权随本项目公开分发；
该确认不改变 Live2D SDK 的独立适用条款。

## 当前运行范围

- 动作包：包含导出的 `Idle`、`Blink`、`Nod`、`Shake`；运行时循环播放 `Idle`，空闲时会间隔触发 `Nod`，截图完成时触发 `Shake`。`Idle` 本身包含眨眼曲线。
- 鼠标跟随：以全局鼠标位置驱动 `ParamEyeBallX` / `ParamEyeBallY`，并在非动作期间联动头部和身体朝向。
- 大小：设置页提供 60%–200% 的缩放滑杆，100% 对应 360 × 540；松开滑杆时保持窗口中心不变并立即生效，最大为 720 × 1080。
- 构图：导出模型的几何边界含有较大的不可见区域；运行时以 2 倍可见角色缩放补偿，避免单纯放大透明窗口而影响桌面点击。
- 头发与果冻眼物理：加载导出的 `clovergirl-2_v1.physics3.json`
- 庆祝嘴型：`ParamMouthForm` / `ParamMouthOpenY`
- 截图完成后的短促庆祝动作
- 左键按住角色拖动窗口

物理在动作和视线参数更新后、模型更新前按帧计算，隐藏窗口后暂停计时。旧的 `clovergirl_v1` 资产已从仓库工作区清理，不应重新加入发布包。

## 导出检查

将 `export/clovergirl-2_v1/` 中的运行时文件复制到 `public/pet-model/clover-girl-2/`，保持模型 JSON 内的相对路径不变，再运行：

```powershell
node tools/verify-live2d-pet-model.mjs public/pet-model/clover-girl-2 clovergirl-2_v1.model3.json
```

该脚本会验证 `model3.json` 引用的 `.moc3`、纹理、显示信息、物理文件和动作文件是否齐全。
