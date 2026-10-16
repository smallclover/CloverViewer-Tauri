//! 用户偏好与实际注册分离；新键注册成功后才释放旧键。
use crate::config::ConfigStore;
use std::{collections::HashMap, str::FromStr, sync::Mutex};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    Screenshot,
    Scroll,
}

#[derive(Default)]
pub struct HotkeyBindings(Mutex<HashMap<Action, Shortcut>>);

#[derive(serde::Serialize)]
pub struct ActiveHotkeys {
    pub show_screenshot: Option<String>,
    pub scroll_capture: Option<String>,
}

/// 库的 Display 输出如 shift+alt+KeyS；所有界面共用常见的按键写法。
fn display_shortcut(shortcut: &Shortcut) -> String {
    let mut parts = Vec::new();
    for (modifier, label) in [
        (Modifiers::CONTROL, "Ctrl"),
        (Modifiers::ALT, "Alt"),
        (Modifiers::SHIFT, "Shift"),
        (Modifiers::SUPER, "Win"),
    ] {
        if shortcut.mods.contains(modifier) {
            parts.push(label);
        }
    }
    let code = shortcut.key.to_string();
    let key = code
        .strip_prefix("Key")
        .or_else(|| code.strip_prefix("Digit"))
        .unwrap_or(&code);
    parts.push(key);
    parts.join("+")
}

pub fn active(app: &AppHandle) -> ActiveHotkeys {
    let bindings = app.state::<HotkeyBindings>();
    let bindings = bindings.0.lock().unwrap();
    ActiveHotkeys {
        show_screenshot: bindings.get(&Action::Screenshot).map(display_shortcut),
        scroll_capture: bindings.get(&Action::Scroll).map(display_shortcut),
    }
}

#[tauri::command]
pub fn get_active_hotkeys(app: AppHandle) -> ActiveHotkeys {
    active(&app)
}

fn register(app: &AppHandle, action: Action, shortcut: Shortcut) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _, event| {
            if event.state() == ShortcutState::Pressed {
                match action {
                    Action::Screenshot => crate::screenshot::start_screenshot(app),
                    Action::Scroll => crate::screenshot::start_scroll_screenshot(app),
                }
            }
        })
        .map_err(|error| error.to_string())
}

fn replace_binding<T: Copy + Eq>(
    old: Option<T>,
    new: T,
    mut register: impl FnMut(T) -> Result<(), String>,
    mut unregister: impl FnMut(T) -> Result<(), String>,
) -> Result<(), String> {
    if old == Some(new) {
        return Ok(());
    }
    register(new)?;
    if let Some(old) = old {
        if let Err(error) = unregister(old) {
            let _ = unregister(new);
            return Err(error);
        }
    }
    Ok(())
}

pub fn change(
    app: &AppHandle,
    store: &ConfigStore,
    action: Action,
    value: String,
) -> Result<(), String> {
    let desired = Shortcut::from_str(&value).map_err(|error| error.to_string())?;
    let bindings = app.state::<HotkeyBindings>();
    let mut bindings = bindings.0.lock().unwrap();
    if bindings
        .iter()
        .any(|(other, key)| *other != action && *key == desired)
    {
        return Err("Shortcut is already assigned to another capture action".into());
    }
    let old = bindings.get(&action).copied();
    replace_binding(
        old,
        desired,
        |key| register(app, action, key),
        |key| {
            app.global_shortcut()
                .unregister(key)
                .map_err(|error| error.to_string())
        },
    )?;
    let persisted = store.update_saved(|config| match action {
        Action::Screenshot => config.hotkeys.show_screenshot = value,
        Action::Scroll => config.hotkeys.scroll_capture = value,
    });
    if let Err(error) = persisted {
        let rollback = if let Some(old) = old {
            replace_binding(
                Some(desired),
                old,
                |key| register(app, action, key),
                |key| {
                    app.global_shortcut()
                        .unregister(key)
                        .map_err(|error| error.to_string())
                },
            )
        } else {
            app.global_shortcut()
                .unregister(desired)
                .map_err(|error| error.to_string())
        };
        if rollback.is_err() {
            bindings.insert(action, desired);
        }
        return Err(format!("{error}; rollback: {rollback:?}"));
    }
    bindings.insert(action, desired);
    drop(bindings);
    crate::tray_menu::refresh(app);
    Ok(())
}

pub fn register_startup(app: &AppHandle, screenshot: &str, scroll: &str) {
    for (action, wanted) in [(Action::Screenshot, screenshot), (Action::Scroll, scroll)] {
        let mut candidates = vec![wanted.to_string()];
        if action == Action::Scroll {
            candidates.extend(
                ["Alt+Shift+A", "Ctrl+Alt+S", "Ctrl+Shift+A", "Alt+Shift+Z"].map(str::to_string),
            );
        }
        let mut actual = None;
        for candidate in candidates {
            let Ok(key) = Shortcut::from_str(&candidate) else {
                continue;
            };
            let bindings = app.state::<HotkeyBindings>();
            let mut bindings = bindings.0.lock().unwrap();
            if bindings.values().any(|existing| *existing == key) {
                continue;
            }
            if register(app, action, key).is_ok() {
                bindings.insert(action, key);
                actual = Some(candidate);
                break;
            }
        }
        if actual.as_deref() != Some(wanted) {
            app.state::<crate::StartupNotices>()
                .push(crate::StartupNotice {
                    kind: if actual.is_some() {
                        "hotkey_fallback"
                    } else {
                        "hotkey_conflict"
                    }
                    .into(),
                    wanted: Some(wanted.into()),
                    used: actual,
                });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn active_shortcut_labels_match_other_ui_hints_and_keep_numpad_distinct() {
        for (registered, label) in [
            ("Alt+S", "Alt+S"),
            ("Shift+Alt+S", "Alt+Shift+S"),
            ("Ctrl+Shift+O", "Ctrl+Shift+O"),
            ("Ctrl+Alt+S", "Ctrl+Alt+S"),
            ("Alt+Shift+A", "Alt+Shift+A"),
            ("Ctrl+Digit1", "Ctrl+1"),
            ("Super+S", "Win+S"),
            ("F1", "F1"),
            ("Ctrl+Numpad1", "Ctrl+Numpad1"),
        ] {
            let shortcut = Shortcut::from_str(registered).unwrap();
            assert_eq!(display_shortcut(&shortcut), label);
        }
    }

    #[test]
    fn registration_failure_keeps_old_binding_and_unregister_failure_rolls_back_new() {
        let events = RefCell::new(Vec::new());
        let result = replace_binding(
            Some(1),
            2,
            |_| Err("occupied".into()),
            |key| {
                events.borrow_mut().push(key);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(events.borrow().is_empty());
        let result = replace_binding(
            Some(1),
            2,
            |_| Ok(()),
            |key| {
                events.borrow_mut().push(key);
                if key == 1 {
                    Err("failed".into())
                } else {
                    Ok(())
                }
            },
        );
        assert!(result.is_err());
        assert_eq!(*events.borrow(), [1, 2]);
    }

    #[test]
    fn registers_new_before_removing_old_and_compares_parsed_shortcuts() {
        let events = RefCell::new(Vec::new());
        replace_binding(
            Some(1),
            2,
            |key| {
                events.borrow_mut().push(("add", key));
                Ok(())
            },
            |key| {
                events.borrow_mut().push(("remove", key));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*events.borrow(), [("add", 2), ("remove", 1)]);
        let a = Shortcut::from_str("Alt+Shift+S").unwrap();
        let b = Shortcut::from_str("Shift+Alt+S").unwrap();
        assert_eq!(a, b);
        replace_binding(
            Some(a),
            b,
            |_| panic!("same parsed key"),
            |_| panic!("same parsed key"),
        )
        .unwrap();
    }
}
