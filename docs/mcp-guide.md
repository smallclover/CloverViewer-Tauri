# CloverViewer MCP 使用指南

CloverViewer 内置的 Model Context Protocol（MCP）服务，让支持 MCP 的 AI 客户端按需查看屏幕、
读取界面文字，并围绕同一张截图持续分析。它是本地屏幕视觉输入工具，不会控制鼠标键盘或修改
其他应用的设置。

## 什么时候适合使用

- 让 AI 查看当前软件的报错、设置页、终端输出、表格或网页，避免手动截图后再上传。
- 有多个显示器时，让 AI 只查看某个屏幕或某块区域。
- 需要从当前界面提取中、英、日文字。
- 要围绕同一画面连续提问，例如先定位错误、再解释原因、最后列出修复步骤。截图的
  `captureId` 可以在会话中重复读取，避免重新截图时画面已经变化。

不适合的场景：远程操作桌面、点击或输入、长期监控屏幕、滚动长截图。这些能力不属于当前 MCP。

## 接入方式

### stdio（推荐桌面 MCP 客户端）

让 MCP 客户端启动 CloverViewer：

```json
{
  "mcpServers": {
    "clover-viewer": {
      "command": "C:\\Path\\To\\CloverViewer.exe",
      "args": ["--mcp"]
    }
  }
}
```

stdio 模式由客户端通过标准输入输出通信；不要在同一进程中向 stdout 写入其他内容。
每个 MCP 客户端都可以独立启动自己的服务进程。

### Streamable HTTP（仅本机程序接入）

```text
CloverViewer.exe --mcp-http --token <secret> [--port 3000]
```

服务只监听 `127.0.0.1` 的 `/mcp`，每个请求必须包含：

```text
Authorization: Bearer <secret>
```

请使用足够随机且不复用的 token。HTTP 模式拒绝非本机 Origin；它不面向局域网或公网访问。

## 常用工作流

```text
list_monitors → take_screenshot → AI 分析图片
                              ├→ ocr_screenshot
                              ├→ get_screenshot
                              └→ delete_screenshot
```

1. 多显示器环境先调用 `list_monitors`，确认显示器 ID、位置和尺寸。
2. 调用 `take_screenshot` 获取新截图。省略目标时捕获活动窗口。
3. 让视觉 AI 直接分析返回的图片；需要文字时使用 `ocr_screenshot`。
4. 用 `captureId` 通过 `get_screenshot` 取回同一张图，或用 `delete_screenshot` 立即删除。

## 工具说明

| 工具 | 用途 |
| --- | --- |
| `list_monitors` | 返回当前显示器的 ID、索引、名称、虚拟桌面坐标、尺寸、主屏状态和可用缩放信息。 |
| `take_screenshot` | 捕获活动窗口、指定显示器、全部显示器或单显示器内的区域。 |
| `get_screenshot` | 通过 `captureId` 重新读取本 MCP 服务进程创建的截图。 |
| `ocr_screenshot` | 对已有截图进行 Windows OCR；语言可选 `zh`、`en` 或 `ja`。 |
| `delete_screenshot` | 删除指定截图。 |

`take_screenshot` 的主要参数：

- `mode`：`active_window`（默认）、`monitor`、`all_monitors` 或 `region`。
- `monitor_id`：来自 `list_monitors` 的当前显示器 ID；也兼容旧的 `monitor_index`，二者不能同时传入。
- `region`：仅搭配 `mode: "region"`；使用虚拟桌面的物理像素坐标 `{ x, y, width, height }`，
  必须完整位于一个显示器内，可使用负坐标。
- `delivery`：`image`（默认）、`path` 或 `both`。默认直接返回 PNG 图片内容和元数据；只有 MCP
  客户端确实能够访问 CloverViewer 所在机器的本地文件时，才应该请求 `path`。
- `max_width`：图片交付的最大宽度，范围为 1–1920 像素；仅影响返回给客户端的图片，不影响保存的原图。

## 示例提示词

- “查看当前活动窗口的报错，说明根因和最小修复步骤。”
- “列出显示器后，截取副屏并找出红色错误信息。”
- “截取坐标 `(0, 0)` 起的 `800×600` 区域，提取其中的文字。”
- “继续分析刚才的截图，检查代理配置是否正常。”

## 存储、隐私与限制

- 截图保存在本机应用数据目录 `CloverViewer/mcp-captures`，默认保留 24 小时，总容量上限 512 MiB。
- `captureId` 仅在创建它的 MCP 服务进程存活期间可用；重启服务后需要重新截图。
- `delete_screenshot` 可在分析结束后立即移除截图。
- 截图内容可能包含敏感数据。仅将 MCP 连接到你信任的 AI 客户端，并避免在提示词或日志中暴露 HTTP token。
- OCR 返回文本；当前版本不返回逐行文字坐标。
