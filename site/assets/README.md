# 展示站图片

- `viewer.webp`：项目已有 release 应用的真实单图查看界面截图。
- `editor.webp`：同一应用的真实九宫格裁切界面截图。
- `alpine-lake.webp`：供产品演示使用的 AI 生成风景图片，不是用户照片。截图中的风景来自此图。
- `../logo.png`：项目原有应用图标。
- `../og-image.png`：与浅色首页一致的 1200×630 社交分享图，使用实际产品截图排版生成。

风景图片使用内置 ImageGen 生成，生成日期为 2026-10-09。最终提示词：

> Use case: photorealistic-natural. Asset type: sample landscape photograph for an open-source image-viewer website's product screenshot. Generate a stunning authentic-looking high-resolution travel photograph of a turquoise alpine lake, pale rugged mountain peaks, evergreen pines framing the left foreground, sunlit rocks at bottom left, soft blue daytime sky with small white clouds. Landscape aspect ratio 16:10. Luminous natural colors, superb photographic detail, inviting but realistic, no illustration, no text, no watermark, no logo, no UI, no borders. This is a new standalone scenic photograph, not a website mockup.

页面保留真实应用截图；OCR 和 MCP 区域是说明性示意，没有调用实际 OCR 或连接 AI 客户端。所有展示图均随静态站点发布，不依赖外部图片服务。
