//! 开机自启 —— 从 CloverViewer (egui 版) 的 os/windows/startup.rs 原样移植。
//!
//! 通过写/删 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的
//! `CloverViewer` 键实现（值为 `"<exe路径>" --startup`，`--startup` 让程序启动后隐藏到托盘）。

#[cfg(windows)]
mod imp {
    use std::env;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const RUN_KEY_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const RUN_VALUE_NAME: &str = "CloverViewer";
    const STARTUP_ARG: &str = "--startup";

    pub fn set_launch_on_startup(enabled: bool) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (run_key, _) = hkcu
            .create_subkey(RUN_KEY_PATH)
            .map_err(|err| format!("open run key failed: {err}"))?;

        if enabled {
            let exe_path =
                env::current_exe().map_err(|err| format!("read exe path failed: {err}"))?;
            let command = format!("\"{}\" {}", exe_path.display(), STARTUP_ARG);
            run_key
                .set_value(RUN_VALUE_NAME, &command)
                .map_err(|err| format!("write run value failed: {err}"))?;
        } else {
            match run_key.delete_value(RUN_VALUE_NAME) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(format!("delete run value failed: {err}")),
            }
        }

        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn set_launch_on_startup(_enabled: bool) -> Result<(), String> {
        Err("开机自启仅在 Windows 上可用".to_string())
    }
}

pub use imp::set_launch_on_startup;
