# 自动更新发布配置

CloverViewer 使用 Tauri Updater 与 GitHub Releases 分发 Windows 更新。客户端只会安装使用 Tauri 更新私钥签名、且能被内置公钥验证的安装包。

## 首次配置

1. 已在仓库根目录生成第一对密钥：

   ```powershell
   npm run tauri signer generate -- -w .tauri/cloverviewer.key
   ```

   公钥已经写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。若需要重新生成，请先确认尚未向用户发布使用当前公钥的版本。
2. `.tauri/cloverviewer.key` 是私钥，已被 `.gitignore` 排除。将它离线备份到密码管理器；不要提交、不要发给他人。
3. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 新建：
   - `TAURI_SIGNING_PRIVATE_KEY`：`.tauri/cloverviewer.key` 的完整文本内容。
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：仅当生成密钥时设置了密码才需要创建。本仓库当前生成的密钥没有密码，可不创建该 Secret。
4. 使用下一版（建议 `v0.1.5`）触发既有发布流程。Actions 会上传 NSIS 安装包、其 `.sig` 签名，以及 `latest.json`。

## 验证首个自动更新版本

1. 用旧版正常安装 `0.1.5`。
2. 发布一个更高版本，例如 `0.1.6`。
3. 启动 `0.1.5`，打开「设置 → 软件更新」，点「检查更新」，应出现更新确认。
4. 确认后等待下载完成。Windows 会显示 NSIS 的小型进度窗口，完成后应用自动重启。

> 更新检查自 v0.1.8 起完全由用户触发：应用不会在启动时或后台自动发起检查，
> 因此也不会在用户不知情时产生网络请求。

更新私钥一旦遗失，已发布的客户端将无法信任新包；发布前务必确认离线备份可用。
