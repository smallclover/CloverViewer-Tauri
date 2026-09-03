//! 配置模块 —— 从 CloverViewer (egui 版) 移植。
//!
//! 序列化格式与原版完全兼容（Language: "Zh"/"En"/"Ja"，
//! ThemePreference: "dark"/"light"/"system"），可直接复用现有 config.json。
//! 存储位置：优先 %APPDATA%/CloverViewer，失败回退 exe 旁（便携模式）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use sys_locale::get_locale;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Language {
    Zh,
    En,
    Ja,
}

impl Language {
    pub fn detect_system() -> Self {
        get_locale()
            .as_deref()
            .and_then(Self::from_locale_tag)
            .unwrap_or(Self::Zh)
    }

    fn from_locale_tag(locale: &str) -> Option<Self> {
        let normalized = locale.replace('_', "-").to_ascii_lowercase();
        let primary = normalized.split('-').next()?;
        match primary {
            "zh" => Some(Self::Zh),
            "ja" => Some(Self::Ja),
            "en" => Some(Self::En),
            _ => None,
        }
    }
}

impl Default for Language {
    fn default() -> Self {
        Self::detect_system()
    }
}

/// 主题偏好（serde 格式与原版一致：dark / light / system）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    Dark,
    Light,
    System,
}

#[derive(Serialize, Deserialize, PartialEq, Clone)]
pub struct HotkeysConfig {
    pub show_screenshot: String,
    #[serde(alias = "copy_screenshot")]
    pub copy_color: String,
}

impl Default for HotkeysConfig {
    fn default() -> Self {
        Self {
            show_screenshot: "Alt+S".to_string(),
            copy_color: "Alt+C".to_string(),
        }
    }
}

#[derive(Serialize, Deserialize, PartialEq, Clone)]
pub struct Config {
    #[serde(default)]
    pub language: Language,
    #[serde(default)]
    pub theme: ThemePreference,
    #[serde(default = "default_zoom_sensitivity")]
    pub zoom_sensitivity: f32,
    #[serde(default)]
    pub hotkeys: HotkeysConfig,
    #[serde(default = "default_minimize_on_close")]
    pub minimize_on_close: bool,
    #[serde(default = "default_magnifier_enabled")]
    pub magnifier_enabled: bool,
    #[serde(default)]
    pub screenshot_hides_main_window: bool,
    #[serde(default = "default_launch_on_startup")]
    pub launch_on_startup: bool,

    #[serde(default)]
    pub window_pos: Option<(f32, f32)>,
    #[serde(default)]
    pub window_size: Option<(f32, f32)>,
}

fn default_zoom_sensitivity() -> f32 {
    1.0
}
fn default_minimize_on_close() -> bool {
    true
}
fn default_magnifier_enabled() -> bool {
    true
}
fn default_launch_on_startup() -> bool {
    false
}

impl Default for Config {
    fn default() -> Self {
        Self {
            language: Language::default(),
            theme: ThemePreference::default(),
            zoom_sensitivity: default_zoom_sensitivity(),
            hotkeys: HotkeysConfig::default(),
            minimize_on_close: default_minimize_on_close(),
            magnifier_enabled: default_magnifier_enabled(),
            screenshot_hides_main_window: false,
            launch_on_startup: default_launch_on_startup(),
            window_pos: None,
            window_size: None,
        }
    }
}

fn get_config_dir() -> PathBuf {
    if let Some(config_dir) = dirs::config_dir() {
        let app_config_dir = config_dir.join("CloverViewer");
        if app_config_dir.exists() || fs::create_dir_all(&app_config_dir).is_ok() {
            return app_config_dir;
        }
    }
    std::env::current_exe()
        .map(|mut p| {
            p.pop();
            p
        })
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn get_config_path() -> PathBuf {
    get_config_dir().join("config.json")
}

fn save_config_internal(path: &std::path::Path, config: &Config) -> bool {
    fs::write(path, serde_json::to_string_pretty(config).unwrap_or_default()).is_ok()
}

pub fn load_config() -> Config {
    let path = get_config_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            match serde_json::from_str::<Config>(&content) {
                Ok(config) => return config,
                Err(e) => {
                    tracing::warn!("配置文件格式错误: {e}，已备份");
                    let _ = fs::rename(&path, path.with_extension("json.backup"));
                }
            }
        }
    }
    Config::default()
}

pub fn save_config(config: &Config) {
    let path = get_config_path();
    if !save_config_internal(&path, config) {
        tracing::error!("无法保存配置到: {path:?}");
    }
}

/// 全局配置存储（Rust 侧持有，前端通过命令读写）
pub struct ConfigStore {
    config: RwLock<Config>,
}

impl ConfigStore {
    pub fn new(config: Config) -> Self {
        Self {
            config: RwLock::new(config),
        }
    }

    pub fn snapshot(&self) -> Arc<Config> {
        let config = self
            .config
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Arc::new(config.clone())
    }

    pub fn replace(&self, new_config: Config) {
        let mut config = self
            .config
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *config = new_config;
    }
}
