# OCR 引擎与可选组件

默认使用 Windows.Media.Ocr。`ocr_language` 与界面语言独立（auto / zh / en / ja），自动模式只尝试已安装的中英日引擎及用户语言引擎。统一评分不再因候选所属语言奖励其结果，也不丢弃不足四字的短文本。原图合成白底后识别，保留抗锯齿与颜色；无可用结果才放大并按需反色，不强制锐化或二值化。位图受系统 MaxImageDimension 限制，按比例缩小；超长图片建议缩小选区识别。

设置 → 文字识别提供可选的 Windows x64 高精度组件：PP-OCRv5 mobile 检测 + server 识别、ONNX Runtime 1.22.0 CPU。单个识别模型支持简繁中文、英文和日文，自动处理混合文本，系统语言选项不限制模型字符集。该组合的实际效果仍应以真实截图对比评估，不保证每张图都优于系统引擎。

下载成功后，按钮显示绿色「✓ 已下载」，状态区明确区分「组件已就绪，尚未启用」与「已下载并启用」。下载不会自动修改引擎选择；在上方手动切换为高精度 OCR 后生效。重新打开设置会读取本机组件状态，删除组件后恢复下载入口与系统 OCR，不需要随软件升级重复下载相同版本的模型。

模型与 DLL 均不捆绑进安装包，不在启动时下载，也不需要 Python。首次完整下载 161,765,143 字节（约154 MiB，含官方运行库压缩包），运行库解压后删除压缩包，模型与运行库文件约98 MiB。组件保存在 `%LOCALAPPDATA%/CloverViewer/ocr/ppocrv5-onnx-3.9.2-ort-1.22.0`，与临时截图缓存分开管理。

`ocr/assets.rs` 固定 URL、版本、字节数与 SHA-256。模型来自 RapidAI 发布在 ModelScope 的 ONNX 转换，运行库来自 Microsoft GitHub Release。下载先写 `.part`，校验成功后替换，全部就绪才写 ready 标记。重试复用已验证的完整文件；取消删除当前残缺文件，已完成文件可在设置中删除。删除前先持久化切回系统 OCR；写配置失败则保留组件。选择尚未安装的高精度引擎会被后端拒绝。

高精度识别使用本程序的 `--ocr-worker <组件目录>` 子进程，通过 stdin PNG / stdout JSON 通信；启动前再次校验全部文件，限定 CPU 线程与任务时长。子进程退出后释放 DLL 文件锁，允许当前会话删除组件。推理包括 DB 检测、旋转文本框裁正与 CTC 解码，长图分块识别；复杂多栏、表格与跨块超长行仍可能存在阅读顺序或断行限制。MCP 与 GUI 共用引擎配置，MCP 显式 language 参数覆盖系统 OCR 语言偏好。识别不上传图片；仅组件下载联网。

## 识别结果的阅读、选择与复制

截图工具栏点击 OCR 后，原始选区在查看器中打开，右侧显示分块结果：

1. 默认按段落阅读，可切换按行或全文。分组采用几何位置，复杂排版不保证自动排序正确；按行选择可作为兜底。
2. 原图点击选择一块，Ctrl+点击增减多选；拖框选择相交的识别行。右侧勾选整块，也可直接拖选一句话或几个字符。
3. 点击右侧正文定位原图。放大、平移、旋转与翻转同步变换高亮；选字模式中按住空格拖动或使用中键平移。
4. “修改”编辑该行所属的段落，支持保存、取消、恢复识别原文。编辑后整段作为一个块参与选择，全文与复制共同使用新文字。
5. 复制所选按阅读顺序输出，不按点击顺序；可整理段落或保留原换行，手工编辑的换行始终保留。Ctrl+C 优先复制浏览器拖选的字符或输入框文字。
6. Esc 先取消拖动/编辑，再清空已有选择，最后关闭结果面板。

原图选取粒度为引擎实际返回的识别行/块，未按字符数猜测逐字坐标。没有坐标的旧文本结果仍可编辑和复制。结果与修改只在当前会话缓存，最多 12 张并有内存预算，不写入持久化 OCR 数据库；缓存淘汰或图片更新会失效。

GUI 使用 `ocr_image_document` 返回 `OcrDocument`，包括输入图片宽高、原始文本与稳定行 ID / 四边形；系统预处理和 Paddle 分片均还原到输入像素。Paddle 子进程输出限制为 20,000 行和 16 MiB，超限明确报错，不截断 JSON。旧 `ocr_image` 与 MCP 保留纯文本输出，共用同一次识别结果。

布局、编辑与选择规则见 [交互设计](ocr-interaction-proposal.md)，自动验证及实际桌面回归边界见 [验证记录](ocr-interaction-validation.md)。

## 上游与许可

- [PaddleOCR PP-OCRv5](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv5/PP-OCRv5.md)：Apache-2.0；[完整许可](PaddleOCR-LICENSE) 随组件安装。
- [RapidOCR 模型与哈希](https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/default_models.yaml)：使用 v3.9.2 ONNX 文件，固定哈希，不依赖 latest；此项目独立实现预后处理，不捆绑 Python 包。
- [ONNX Runtime 1.22.0](https://github.com/microsoft/onnxruntime/releases/tag/v1.22.0)：MIT，官方 LICENSE 与 ThirdPartyNotices.txt 随运行库保留。
- [ort 2.0.0-rc.10](https://docs.rs/ort/2.0.0-rc.10/ort/)：MIT / Apache-2.0，启用 load-dynamic，关闭自动下载与 DLL 拷贝。

修改资产版本时须重新下载并核实字节数、SHA-256、字符字典、运行库 API 兼容性与许可；同步三语体积提示并验证真实中英日样例。
